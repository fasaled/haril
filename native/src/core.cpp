// core.cpp — HarilContext::Impl + the C API wrappers.
//
// HarilContext is a pimpl facade. All Windows-specific state, threads,
// TDH schema cache, and ETW/USN workers live in `HarilContext::Impl`
// (declared in core.cpp). The public class is a thin wrapper that owns
// the impl via std::unique_ptr.
//
// Modern C++ (C++20 + selected C++23 features via /stdcpplatest):
//   - std::jthread (RAII auto-join on stop or destruction)
//   - std::stop_source_eligible threading
//   - std::span, std::unique_ptr with custom deleter for Win32 handles
//   - VirtualAlloc-backed RingBuffer owns its memory via destructor
//   - TdhGetEventInformation (schema) + TdhFormatProperty (value)
//
// This file is the only one that includes Windows headers. The public
// header `core.h` and the Node-API addon stay free of <windows.h>.

#include "core.h"
#include "haril_native.h"

#include <windows.h>
#include <evntrace.h>
#include <evntcons.h>
#include <tdh.h>
#include <winefs.h>
#include <winioctl.h>
#include <shellapi.h>
#include <objbase.h>
#include <sddl.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cstring>
#include <mutex>
#include <span>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <vector>

// ----------------------- RingBuffer (SPSC, lock-free) -----------------------

namespace {

constexpr std::size_t kRingCapacity = 262144;  // 256k slots
constexpr std::size_t kRingBytes   = kRingCapacity * HARIL_SLOT_SIZE;

struct alignas(64) PaddedAtomic {
    std::atomic<std::uint64_t> v{0};
};

// Disruptor-style Lock-Free Multi-Producer Single-Consumer (MPSC) Ring Buffer.
// Producers claim slots atomically using fetch_add and publish via monotonic flags.
// The consumer tracks contiguous published slots, eliminating mutexes and thread blocking.
class RingBuffer {
public:
    RingBuffer() {
        storage_ = static_cast<std::uint8_t*>(
            VirtualAlloc(nullptr, kRingBytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE));
        if (!storage_) throw std::runtime_error("RingBuffer: VirtualAlloc failed");
        std::memset(storage_, 0, kRingBytes);

        available_ = static_cast<std::atomic<std::uint64_t>*>(
            VirtualAlloc(nullptr, kRingCapacity * sizeof(std::atomic<std::uint64_t>), MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE));
        if (!available_) {
            VirtualFree(storage_, 0, MEM_RELEASE);
            throw std::runtime_error("RingBuffer: VirtualAlloc for available_ failed");
        }
        for (std::size_t i = 0; i < kRingCapacity; i++) {
            new (&available_[i]) std::atomic<std::uint64_t>(0);
        }
    }
    ~RingBuffer() {
        if (available_) VirtualFree(available_, 0, MEM_RELEASE);
        if (storage_) VirtualFree(storage_, 0, MEM_RELEASE);
    }
    RingBuffer(const RingBuffer&) = delete;
    RingBuffer& operator=(const RingBuffer&) = delete;

    bool push(std::span<const std::uint8_t> data) noexcept {
        if (data.size() > HARIL_SLOT_SIZE) return false;

        // Atomically claim a sequence ticket (Disruptor claim phase)
        const std::uint64_t seq = head_seq_.v.fetch_add(1, std::memory_order_relaxed);
        const std::uint64_t t = tail_seq_.v.load(std::memory_order_acquire);

        // Check if buffer is full (backpressure)
        if (seq - t >= kRingCapacity) {
            return false;
        }

        const std::size_t index = seq % kRingCapacity;
        std::uint8_t* dst = storage_ + index * HARIL_SLOT_SIZE;
        std::memcpy(dst, data.data(), data.size());
        if (data.size() < HARIL_SLOT_SIZE) {
            std::memset(dst + data.size(), 0, HARIL_SLOT_SIZE - data.size());
        }

        // Publish publication marker: seq + 1 (1-based to distinguish from 0 initial state)
        available_[index].store(seq + 1, std::memory_order_release);
        return true;
    }

    int pop_batch(std::span<std::uint8_t> out, std::uint64_t* out_seq) noexcept {
        const std::uint64_t t = tail_seq_.v.load(std::memory_order_relaxed);
        const int max_slots = static_cast<int>(out.size() / HARIL_SLOT_SIZE);
        int n = 0;

        // Collect contiguous published slots
        while (n < max_slots) {
            const std::uint64_t seq = t + n;
            const std::size_t index = seq % kRingCapacity;
            // A slot is published if its available_ marker matches seq + 1
            if (available_[index].load(std::memory_order_acquire) != seq + 1) {
                break;
            }
            const std::uint8_t* src = storage_ + index * HARIL_SLOT_SIZE;
            std::memcpy(out.data() + static_cast<std::size_t>(n) * HARIL_SLOT_SIZE, src, HARIL_SLOT_SIZE);
            n++;
        }

        if (n > 0) {
            tail_seq_.v.store(t + n, std::memory_order_release);
            if (out_seq) *out_seq = seq_high_.fetch_add(1, std::memory_order_relaxed) + 1;
        }
        return n;
    }

    // Debug accessors
    std::uint64_t head() const noexcept { return head_seq_.v.load(std::memory_order_relaxed); }
    std::uint64_t tail() const noexcept { return tail_seq_.v.load(std::memory_order_relaxed); }

private:
    std::uint8_t* storage_ = nullptr;
    std::atomic<std::uint64_t>* available_ = nullptr;
    PaddedAtomic head_seq_;
    PaddedAtomic tail_seq_;
    std::atomic<std::uint64_t> seq_high_{0};
};

// ----------------------- RAII handles -----------------------

struct HandleDeleter {
    void operator()(HANDLE h) const noexcept {
        if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h);
    }
};
using UniqueHandle = std::unique_ptr<void, HandleDeleter>;

inline UniqueHandle make_unique(HANDLE h) noexcept {
    return UniqueHandle(h == INVALID_HANDLE_VALUE ? nullptr : h);
}

// ----------------------- Raw slot for ETW callback (minimal stack) -----------------------
//
// The ETW callback must be fast and avoid heap allocations, complex loops,
// or function calls. We store a raw record and decode it later during drain.
// Layout (little-endian):
//   [0..2)   source      u16
//   [2..4)   kind        u16
//   [4..12)  ts_ns       u64
//   [12..16) pid         u32
//   [16..20) tid         u32
//   [20..28) irpPtr      u64
//   [28..32) ntStatus    u32
//   [32..48) fileId      16 bytes
//   [48..52) vsn         u32
//   [52..56) byteOffset  u32
//   [56..60) byteLen     u32
//   [60..64) shareAccess u32
//   [64..68) createOpts  u32
//   [68..72) createDisp  u32
//   [72..76) sourceIdx   u32
//   [76..78) pathLen     u16 (UTF-16 code units, max 48)
//   [78..174) pathUTF16   96 bytes (48 UTF-16 chars)
//   [174..270) procUTF16  96 bytes (48 UTF-16 chars)
//
// Total: must fit in 256.
constexpr std::size_t HARIL_RAW_SLOT_SIZE = 256;

#pragma pack(push, 1)
struct RawEtwSlot {
    std::uint16_t source;
    std::uint16_t kind;
    std::uint64_t ts_ns;
    std::uint32_t pid;
    std::uint32_t tid;
    std::uint64_t irp;
    std::uint32_t ntStatus;
    std::uint8_t  fileId[16];
    std::uint32_t vsn;
    std::uint32_t byteOffset;
    std::uint32_t byteLen;
    std::uint32_t shareAccess;
    std::uint32_t createOpts;
    std::uint32_t createDisp;
    std::uint32_t sourceIdx;
    std::uint16_t pathLen;      // UTF-16 code units
    wchar_t       path[32];     // UTF-16
    wchar_t       proc[32];     // UTF-16
};
#pragma pack(pop)
static_assert(sizeof(RawEtwSlot) <= HARIL_RAW_SLOT_SIZE, "RawEtwSlot too large");

// Encode a raw slot in the callback (fast, no function calls, no loops over string).
// The path is copied with a simple bounded memcpy.
inline void encode_raw_slot(RawEtwSlot* s,
                            std::uint16_t source, std::uint16_t kind, std::uint64_t ts_ns,
                            std::uint32_t pid, std::uint32_t tid, std::uint64_t irp, std::uint32_t ntStatus,
                            const std::uint8_t fileId[16], std::uint32_t vsn,
                            std::uint32_t byteOffset, std::uint32_t byteLen,
                            std::uint32_t shareAccess, std::uint32_t createOpts, std::uint32_t createDisp,
                            std::uint32_t sourceIdx,
                            const wchar_t* path, std::size_t pathLen,
                            const wchar_t* proc, std::size_t procLen) noexcept {
    s->source = source;
    s->kind = kind;
    s->ts_ns = ts_ns;
    s->pid = pid;
    s->tid = tid;
    s->irp = irp;
    s->ntStatus = ntStatus;
    if (fileId) std::memcpy(s->fileId, fileId, 16);
    s->vsn = vsn;
    s->byteOffset = byteOffset;
    s->byteLen = byteLen;
    s->shareAccess = shareAccess;
    s->createOpts = createOpts;
    s->createDisp = createDisp;
    s->sourceIdx = sourceIdx;
    s->pathLen = static_cast<std::uint16_t>(std::min<std::size_t>(pathLen, 32));
    std::memcpy(s->path, path, s->pathLen * sizeof(wchar_t));
    // Zero the rest of path
    if (s->pathLen < 32) std::memset(s->path + s->pathLen, 0, (32 - s->pathLen) * sizeof(wchar_t));
    std::memcpy(s->proc, proc, std::min<std::size_t>(procLen, 32) * sizeof(wchar_t));
    if (procLen < 32) std::memset(s->proc + procLen, 0, (32 - procLen) * sizeof(wchar_t));
}

// Decode a raw slot to the full HARIL_SLOT_SIZE format during drain.
void decode_raw_slot(const RawEtwSlot* raw, std::span<std::uint8_t, HARIL_SLOT_SIZE> out) noexcept {
    std::memset(out.data(), 0, HARIL_SLOT_SIZE);
    std::uint8_t* p = out.data();
    *reinterpret_cast<std::uint16_t*>(p + 0)   = raw->source;
    *reinterpret_cast<std::uint16_t*>(p + 2)   = raw->kind;
    *reinterpret_cast<std::uint64_t*>(p + 4)   = raw->ts_ns;
    *reinterpret_cast<std::uint32_t*>(p + 12)  = raw->pid;
    *reinterpret_cast<std::uint32_t*>(p + 16)  = raw->tid;
    *reinterpret_cast<std::uint64_t*>(p + 20)  = raw->irp;
    *reinterpret_cast<std::uint32_t*>(p + 28)  = raw->ntStatus;
    std::memcpy(p + 32, raw->fileId, 16);
    *reinterpret_cast<std::uint32_t*>(p + 48)  = raw->vsn;
    *reinterpret_cast<std::uint32_t*>(p + 52)  = raw->byteOffset;
    *reinterpret_cast<std::uint32_t*>(p + 56)  = raw->byteLen;
    *reinterpret_cast<std::uint32_t*>(p + 60)  = raw->shareAccess;
    *reinterpret_cast<std::uint32_t*>(p + 64)  = raw->createOpts;
    *reinterpret_cast<std::uint32_t*>(p + 68)  = raw->createDisp;
    *reinterpret_cast<std::uint32_t*>(p + 72)  = raw->sourceIdx;
    p[76] = static_cast<std::uint8_t>(raw->pathLen);
    // Inline put_utf16 for path
    {
        const int max_chars = 32 / 2 - 1; // 15
        const int n = std::min<int>(raw->pathLen, max_chars);
        for (int i = 0; i < n; i++) {
            const std::uint16_t c = static_cast<std::uint16_t>(raw->path[i]);
            p[80 + i * 2]     = static_cast<std::uint8_t>(c & 0xFF);
            p[80 + i * 2 + 1] = static_cast<std::uint8_t>(c >> 8);
        }
        if (n < max_chars) {
            p[80 + n * 2]     = 0;
            p[80 + n * 2 + 1] = 0;
        }
    }
    // Inline put_utf16 for proc
    {
        const int max_chars = 64 / 2 - 1; // 31
        // Find actual proc length (bounded by 32)
        int proc_len = 0;
        while (proc_len < 32 && raw->proc[proc_len] != L'\0') proc_len++;
        const int n = std::min<int>(proc_len, max_chars);
        for (int i = 0; i < n; i++) {
            const std::uint16_t c = static_cast<std::uint16_t>(raw->proc[i]);
            p[112 + i * 2]     = static_cast<std::uint8_t>(c & 0xFF);
            p[112 + i * 2 + 1] = static_cast<std::uint8_t>(c >> 8);
        }
        if (n < max_chars) {
            p[112 + n * 2]     = 0;
            p[112 + n * 2 + 1] = 0;
        }
    }
}

// USN extension block, written into the slot's reserved area by the USN
// producer thread only. Layout (little-endian):
//   [176..184] fileReferenceNumber       u64
//   [184..192] parentFileReferenceNumber u64
//   [192..200] usn                       u64
//   [200..204] reason                    u32
// [204..256] still reserved.

// Slot encoding for non-callback paths (USN, inventory, etc.)
inline void put_utf16(std::uint8_t* dst, int dst_bytes, std::wstring_view s) noexcept {
    const int max_chars = dst_bytes / 2 - 1;
    const int n = (max_chars <= 0)
        ? 0
        : static_cast<int>(std::min<std::size_t>(s.size(), static_cast<std::size_t>(max_chars)));
    for (int i = 0; i < n; i++) {
        const std::uint16_t c = static_cast<std::uint16_t>(s[i]);
        dst[i * 2]     = static_cast<std::uint8_t>(c & 0xFF);
        dst[i * 2 + 1] = static_cast<std::uint8_t>(c >> 8);
    }
    if (n < max_chars) {
        dst[n * 2]     = 0;
        dst[n * 2 + 1] = 0;
    }
}

inline void encode_event_slot(std::span<std::uint8_t, HARIL_SLOT_SIZE> s,
                       std::uint16_t source, std::uint16_t kind, std::uint64_t ts_ns,
                       std::uint32_t pid, std::uint32_t tid, std::uint64_t irp, std::uint32_t ntStatus,
                       const std::uint8_t fileId[16], std::uint32_t vsn,
                       std::uint32_t byteOffset, std::uint32_t byteLen,
                       std::uint32_t shareAccess, std::uint32_t createOpts, std::uint32_t createDisp,
                       std::uint32_t sourceIdx,
                       std::wstring_view path, std::wstring_view proc) noexcept {
    std::memset(s.data(), 0, HARIL_SLOT_SIZE);
    std::uint8_t* p = s.data();
    *reinterpret_cast<std::uint16_t*>(p + 0)   = source;
    *reinterpret_cast<std::uint16_t*>(p + 2)   = kind;
    *reinterpret_cast<std::uint64_t*>(p + 4)   = ts_ns;
    *reinterpret_cast<std::uint32_t*>(p + 12)  = pid;
    *reinterpret_cast<std::uint32_t*>(p + 16)  = tid;
    *reinterpret_cast<std::uint64_t*>(p + 20)  = irp;
    *reinterpret_cast<std::uint32_t*>(p + 28)  = ntStatus;
    if (fileId) std::memcpy(p + 32, fileId, 16);
    *reinterpret_cast<std::uint32_t*>(p + 48)  = vsn;
    *reinterpret_cast<std::uint32_t*>(p + 52)  = byteOffset;
    *reinterpret_cast<std::uint32_t*>(p + 56)  = byteLen;
    *reinterpret_cast<std::uint32_t*>(p + 60)  = shareAccess;
    *reinterpret_cast<std::uint32_t*>(p + 64)  = createOpts;
    *reinterpret_cast<std::uint32_t*>(p + 68)  = createDisp;
    *reinterpret_cast<std::uint32_t*>(p + 72)  = sourceIdx;
    p[76] = static_cast<std::uint8_t>(std::min<std::size_t>(path.size(), 64));
    put_utf16(p + 80, 32, path);
    put_utf16(p + 112, 64, proc);
}

void encode_usn_extension(std::span<std::uint8_t, HARIL_SLOT_SIZE> s,
                         std::uint64_t frn, std::uint64_t parentFrn,
                         std::uint64_t usn, std::uint32_t reason) noexcept {
    std::uint8_t* p = s.data();
    *reinterpret_cast<std::uint64_t*>(p + 176) = frn;
    *reinterpret_cast<std::uint64_t*>(p + 184) = parentFrn;
    *reinterpret_cast<std::uint64_t*>(p + 192) = usn;
    *reinterpret_cast<std::uint32_t*>(p + 200) = reason;
}

std::uint64_t qpc_to_ns(LARGE_INTEGER qpc, LARGE_INTEGER freq) noexcept {
    if (freq.QuadPart == 0) return 0;
    return static_cast<std::uint64_t>(
        (qpc.QuadPart * 1000000000ULL) / static_cast<std::uint64_t>(freq.QuadPart));
}

constexpr std::uint16_t kKindCreate = 1;
constexpr std::uint16_t kKindOpen   = 2;
constexpr std::uint16_t kKindSetInfo= 4;
constexpr std::uint16_t kKindWrite  = 5;
constexpr std::uint16_t kKindClose  = 6;
constexpr std::uint16_t kKindOpEnd  = 9;
constexpr std::uint16_t kKindNotify = 10;

// ----------------------- ETW constants -----------------------

constexpr GUID Microsoft_Windows_Kernel_File_GUID =
    { 0xBCC65049, 0x262F, 0x4E83, { 0xAB, 0x1E, 0x2D, 0xA0, 0x4F, 0xEA, 0x59, 0x95 } };
// MOF-based Kernel FileIo provider (used by NT Kernel Logger).
// GUID: {90CB6C39-5F2F-4E83-AB1E-2DA04FEA5995}
constexpr GUID Microsoft_Windows_Kernel_File_MOF_GUID =
    { 0x90CB6C39, 0x5F2F, 0x4E83, { 0xAB, 0x1E, 0x2D, 0xA0, 0x4F, 0xEA, 0x59, 0x95 } };
constexpr GUID Microsoft_Windows_Kernel_Process_GUID =
    { 0x22FB2CD6, 0x0E7B, 0x422B, { 0xA0, 0xC7, 0x2F, 0xAD, 0x11, 0xA0, 0xB2, 0xCA } };

// SystemTraceControlGuid is exported by Advapi32.lib but its header
// definition is conditional on INITGUID.
constexpr GUID SystemTraceControlGuidLocal =
    { 0x9E814AAD, 0x3204, 0x11D2, { 0x9A, 0x82, 0x00, 0x60, 0x08, 0xA8, 0x69, 0x39 } };

// Map a Kernel FileIo MOF event (id=0, ver=3) to a Haril kind by opcode.
// TDH cannot decode these MOF events (rc=1168), so we use the empirical
// field layout discovered via survey4:
//   op=64 Create, op=72 Read, op=74 Write, op=80 SetInfo/Rename,
//   op=65/66 Close/Cleanup, op=76 OpEnd.
std::uint16_t map_kind(std::uint16_t opcode, const GUID& provider) noexcept {
    const bool isFileIo = (provider == Microsoft_Windows_Kernel_File_GUID) ||
                           (provider == Microsoft_Windows_Kernel_File_MOF_GUID) ||
                           (provider.Data1 == 0x90CBDC39);  // MOF Kernel FileIo (surveyed)
    if (isFileIo) {
        switch (opcode) {
            case 64: return kKindCreate;
            case 72: return kKindOpen;    // Read
            case 74: return kKindWrite;
            case 80: return kKindSetInfo; // Rename/SetInfo
            case 65: case 66: return kKindClose;
            case 76: return kKindOpEnd;
            default: return 0;
        }
    }
    if (provider == Microsoft_Windows_Kernel_Process_GUID) {
        if (opcode == 1) return kKindCreate;
    }
    return 0;
}

std::wstring normalize_path_for_cmp(std::wstring_view s) {
    std::wstring out;
    out.reserve(s.size());
    for (wchar_t c : s) {
        out.push_back(c == L'/' ? L'\\' : static_cast<wchar_t>(towlower(c)));
    }
    if (out.size() > 3 && out.back() == L'\\') out.pop_back();
    return out;
}

bool path_starts_with(std::wstring_view p, std::wstring_view root) {
    if (root.empty()) return true;
    const auto a = normalize_path_for_cmp(p);
    const auto b = normalize_path_for_cmp(root);
    if (a.size() < b.size()) return false;
    for (std::size_t i = 0; i < b.size(); i++) {
        if (a[i] != b[i]) return false;
    }
    if (a.size() == b.size()) return true;
    return a[b.size()] == L'\\';
}

// ----------------------- TDH decoder helpers -----------------------

std::wstring format_property(PTRACE_EVENT_INFO info,
                            std::uint32_t propertyIndex,
                            PEVENT_RECORD rec) {
    if (!info || propertyIndex >= info->TopLevelPropertyCount) return {};
    const PEVENT_PROPERTY_INFO prop = &info->EventPropertyInfoArray[propertyIndex];
    if (prop->Flags & PropertyStruct) return {};

    const std::uint16_t pointerSize =
        (rec->EventHeader.Flags & EVENT_HEADER_FLAG_32_BIT_HEADER) ? 4 : 8;

    std::uint32_t neededChars = 0;
    std::uint16_t consumed = 0;
    TdhFormatProperty(
        info, nullptr, static_cast<std::uint32_t>(pointerSize),
        prop->nonStructType.InType, prop->nonStructType.OutType,
        /*PropertyLength=*/0,
        static_cast<std::uint16_t>(rec->UserDataLength),
        static_cast<PBYTE>(rec->UserData),
        reinterpret_cast<PULONG>(&neededChars), nullptr, &consumed);
    if (neededChars == 0) return {};

    std::wstring result_str(neededChars, L'\0');
    const TDHSTATUS rc = TdhFormatProperty(
        info, nullptr, static_cast<std::uint32_t>(pointerSize),
        prop->nonStructType.InType, prop->nonStructType.OutType,
        /*PropertyLength=*/0,
        static_cast<std::uint16_t>(rec->UserDataLength),
        static_cast<PBYTE>(rec->UserData),
        reinterpret_cast<PULONG>(&neededChars), result_str.data(), &consumed);
    if (rc != ERROR_SUCCESS) return {};

    while (!result_str.empty() && result_str.back() == L'\0') result_str.pop_back();
    return result_str;
}

// ----------------------- Inventory walker -----------------------

struct InventoryEmitRecord {
    std::uint64_t lastWriteTime;
    std::uint64_t creationTime;
    std::uint32_t length;
    std::uint32_t attributes;
    std::uint8_t  fileId128[16];
    std::uint32_t volumeSerial;
    std::uint16_t pathLen;
};

void walk_dir_recursive(std::wstring_view root, std::vector<InventoryEmitRecord>& out) {
    WIN32_FIND_DATAW fd{};
    const std::wstring pattern = std::wstring(root) + L"\\*";
    const UniqueHandle h(make_unique(FindFirstFileW(pattern.c_str(), &fd)));
    if (!h) return;

    do {
        if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
        const std::wstring full = std::wstring(root) + L"\\" + fd.cFileName;
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            walk_dir_recursive(full, out);
            continue;
        }

        const UniqueHandle hf(make_unique(CreateFileW(
            full.c_str(), 0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr)));
        FILE_ID_INFO id{};
        std::uint32_t vsn = 0;
        if (hf) {
            if (GetFileInformationByHandleEx(hf.get(), FileIdInfo, &id, sizeof(id))) {
                vsn = static_cast<std::uint32_t>(id.VolumeSerialNumber);
            }
        }

        ULARGE_INTEGER ullwt{}, ullct{};
        ullwt.LowPart = fd.ftLastWriteTime.dwLowDateTime;
        ullwt.HighPart = fd.ftLastWriteTime.dwHighDateTime;
        ullct.LowPart = fd.ftCreationTime.dwLowDateTime;
        ullct.HighPart = fd.ftCreationTime.dwHighDateTime;

        InventoryEmitRecord rec{};
        rec.lastWriteTime = ullwt.QuadPart;
        rec.creationTime  = ullct.QuadPart;
        rec.length        = static_cast<std::uint32_t>(
            static_cast<std::uint64_t>(fd.nFileSizeLow) |
            (static_cast<std::uint64_t>(fd.nFileSizeHigh) << 32));
        rec.attributes    = fd.dwFileAttributes;
        std::memcpy(rec.fileId128, id.FileId.Identifier, 16);
        rec.volumeSerial  = vsn;
        rec.pathLen       = static_cast<std::uint16_t>(full.size());
        out.push_back(rec);
    } while (FindNextFileW(h.get(), &fd));
}

// Rich rows (InventoryRow, declared in core.h) including the full path,
// for the synchronous N-API inventoryWalk export.

void walk_dir_rows(std::wstring_view root, std::vector<InventoryRow>& out) {
    WIN32_FIND_DATAW fd{};
    const std::wstring pattern = std::wstring(root) + L"\\*";
    const UniqueHandle h(make_unique(FindFirstFileW(pattern.c_str(), &fd)));
    if (!h) return;

    do {
        if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
        const std::wstring full = std::wstring(root) + L"\\" + fd.cFileName;
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            walk_dir_rows(full, out);
            continue;
        }

        const UniqueHandle hf(make_unique(CreateFileW(
            full.c_str(), 0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr)));
        FILE_ID_INFO id{};
        std::uint32_t vsn = 0;
        bool hasId = false;
        if (hf) {
            if (GetFileInformationByHandleEx(hf.get(), FileIdInfo, &id, sizeof(id))) {
                vsn = static_cast<std::uint32_t>(id.VolumeSerialNumber);
                hasId = true;
            }
        }

        ULARGE_INTEGER ullwt{}, ullct{};
        ullwt.LowPart = fd.ftLastWriteTime.dwLowDateTime;
        ullwt.HighPart = fd.ftLastWriteTime.dwHighDateTime;
        ullct.LowPart = fd.ftCreationTime.dwLowDateTime;
        ullct.HighPart = fd.ftCreationTime.dwHighDateTime;

        InventoryRow row{};
        row.path = full;
        row.lastWriteTime = ullwt.QuadPart;
        row.creationTime  = ullct.QuadPart;
        row.length        = static_cast<std::uint32_t>(
            static_cast<std::uint64_t>(fd.nFileSizeLow) |
            (static_cast<std::uint64_t>(fd.nFileSizeHigh) << 32));
        row.attributes    = fd.dwFileAttributes;
        std::memcpy(row.fileId128, id.FileId.Identifier, 16);
        row.volumeSerial  = vsn;
        row.hasFileId     = hasId;
        out.push_back(std::move(row));
    } while (FindNextFileW(h.get(), &fd));
}

}  // namespace

// ----------------------- HarilContext::Impl -----------------------

struct HarilContext::Impl {
    RingBuffer ring;

    std::atomic<bool> etwRunning{false};
    std::atomic<bool> usnRunning{false};
    std::atomic<bool> etwStopRequested{false};
    std::atomic<bool> usnStopRequested{false};

    // ETW
    TRACEHANDLE etwSessionHandle = 0;
    TRACEHANDLE etwConsumerHandle = INVALID_PROCESSTRACE_HANDLE;
    bool etwOwnsSession = false;  // only stop sessions we started
    std::wstring etwSessionName;
    std::wstring etwTargetRoot;
    // Fixed buffer for target root (lowercase, no trailing backslash) for callback use.
    wchar_t etwTargetRootFixed[512];
    std::size_t etwTargetRootFixedLen = 0;
    // NT device prefix (L"\\Device\\HarddiskVolumeN") -> drive ("C:").
    // Built once at etw_start; volumes rarely change mid-capture.
    // Fixed arrays for callback use (no heap allocation).
    struct DevicePrefix {
        wchar_t device[256];
        std::size_t deviceLen;
        wchar_t drive[8];  // e.g., "C:"
        std::size_t driveLen;
    };
    DevicePrefix devicePrefixesFixed[32];
    std::size_t devicePrefixCount = 0;
    std::vector<std::pair<std::wstring, std::wstring>> devicePrefixMap;  // for non-callback use
    std::atomic<std::uint64_t> etwEventsLost{0};
    std::atomic<std::uint64_t> etwEventsObserved{0};
    std::atomic<std::uint64_t> etwOutOfScope{0};
    std::atomic<std::uint64_t> etwWithoutPath{0};
    std::atomic<std::uint64_t> etwBuffersWritten{0};
    std::atomic<std::uint64_t> etwRingPushFailed{0};
    std::atomic<std::uint64_t> etwPushAttempted{0};
    std::atomic<std::uint64_t> etwKindZero{0};
    std::atomic<std::uint64_t> etwAfterKind{0};  // Debug: reached after kind check
    std::atomic<std::uint64_t> etwAfterScope{0};  // Debug: reached after scope check
    std::atomic<std::uint64_t> usnDroppedUnresolved{0};
    std::jthread etwThread;

    // USN
    std::wstring usnVolume;
    std::wstring usnTargetRoot;  // scope filter; empty = no filtering
    UniqueHandle usnVolumeHandle;
    USN_JOURNAL_DATA usnJournal{};
    std::uint64_t usnCursor = 0;  // next USN to read; set at start
    std::atomic<std::uint64_t> usnRecordsRead{0};
    std::jthread usnThread;

    // TDH schema cache
    std::mutex schemaMutex;
    std::unordered_map<std::uint64_t, std::vector<std::uint8_t>> schemaCache;

    // For Impl's destructor to call into helper functions, hold a
    // back-reference to the owning HarilContext. Set in HarilContext ctor.
    HarilContext* owner = nullptr;

    // Schema fetch (one-shot query, no caching here; the cache itself is
    // a separate path the public methods populate via the cache helpers).
    std::span<const std::uint8_t> get_schema(const GUID& provider,
                                            std::uint16_t eventId,
                                            std::uint8_t  version) {
        const std::uint64_t key = (static_cast<std::uint64_t>(eventId) << 32) |
                                  (static_cast<std::uint64_t>(version) << 16) |
                                  HarilContext::hash_guid(provider);

        {
            std::lock_guard<std::mutex> lk(schemaMutex);
            auto it = schemaCache.find(key);
            if (it != schemaCache.end()) return std::span<const std::uint8_t>(it->second);
        }

        EVENT_DESCRIPTOR desc{eventId, 0, 0, version, 0, 0, 0};
        EVENT_RECORD rec{};
        rec.EventHeader.ProviderId = provider;
        rec.EventHeader.EventDescriptor = desc;
        std::uint32_t size = 0;
        TdhGetEventInformation(&rec, 0, nullptr, nullptr, reinterpret_cast<PULONG>(&size));
        if (size == 0) return {};

        std::vector<std::uint8_t> buf(size);
        if (TdhGetEventInformation(&rec, 0, nullptr,
                                   reinterpret_cast<PTRACE_EVENT_INFO>(buf.data()),
                                   reinterpret_cast<PULONG>(&size)) != ERROR_SUCCESS) {
            return {};
        }

        std::lock_guard<std::mutex> lk(schemaMutex);
        schemaCache.emplace(key, std::move(buf));
        auto it = schemaCache.find(key);
        return std::span<const std::uint8_t>(it->second);
    }

    // ETW EventCallback — manual MOF parser for Kernel FileIo events.
    //
    // TdhGetEventInformation returns ERROR_NOT_FOUND (1168) for kernel MOF
    // events, so we decode the fixed-offset layout empirically discovered
    // via survey4 (provider 90cbdc39, id=0, ver=3):
    //   [0..8)   FileObject (u64)
    //   [8..16)  IrpPtr (u64)
    //   [16..20) createOptions (u32)  — Create only
    //   [20..24) createDisposition (u32) — Create only
    //   [24..28) shareAccess (u32)    — Create only
    //   [28..32) padding
    //   [32..]   FileName (UTF-16, NUL-terminated)
    //
    // Events without a path (Close/Cleanup/OpEnd) are dropped.
    // ETW EventCallback — manual MOF parser for Kernel FileIo events.
//
// TdhGetEventInformation returns ERROR_NOT_FOUND (1168) for kernel MOF
// events, so we decode the fixed-offset layout empirically discovered
// via survey4 (provider 90cbdc39, id=0, ver=3):
//   [0..8)   FileObject (u64)
//   [8..16)  IrpPtr (u64)
//   [16..20) createOptions (u32)  — Create only
//   [20..24) createDisposition (u32) — Create only
//   [24..28) shareAccess (u32)    — Create only
//   [28..32) padding
//   [32..]   FileName (UTF-16, NUL-terminated)
//
// Events without a path (Close/Cleanup/OpEnd) are dropped.
    // Events without a path (Close/Cleanup/OpEnd) are dropped.
    static VOID WINAPI EtwEventCallback(PEVENT_RECORD rec) {
        auto* self = static_cast<Impl*>(rec->UserContext);
        if (!self) return;
        // Early exit if stopping to avoid race during teardown
        if (self->etwStopRequested.load(std::memory_order_relaxed)) return;
        self->etwEventsObserved.fetch_add(1, std::memory_order_relaxed);

        const GUID& provider = rec->EventHeader.ProviderId;
        const std::uint16_t opcode = rec->EventHeader.EventDescriptor.Opcode;

        // Only Kernel FileIo (Manifest or MOF) and Kernel Process are in scope.
        // NT Kernel Logger uses MOF provider with Data1=0x90CBDC39 (surveyed).
        // Manifest provider has Data1=0xBCC65049.
        const bool isFileIo = (provider == Microsoft_Windows_Kernel_File_GUID) ||
                               (provider == Microsoft_Windows_Kernel_File_MOF_GUID) ||
                               (provider.Data1 == 0x90CBDC39);  // MOF Kernel FileIo (surveyed)
        const bool isProcess = (provider == Microsoft_Windows_Kernel_Process_GUID);
        if (!isFileIo && !isProcess) return;

        // Validate UserData pointer and length.
        const auto* ud = static_cast<const std::uint8_t*>(rec->UserData);
        const auto udLen = rec->UserDataLength;
        if (!ud || udLen < 34) {  // need at least 32 bytes header + 2 bytes for NUL
            self->etwWithoutPath.fetch_add(1, std::memory_order_relaxed);
            return;
        }

        // Extract path from fixed offset 32 (UTF-16, NUL-terminated).
        // Use a fixed-size stack buffer to avoid std::wstring allocation in callback.
        wchar_t pathBuf[1024];
        std::size_t pathLen = 0;
        if (32 + 2 <= udLen) {
            const auto* p = reinterpret_cast<const wchar_t*>(ud + 32);
            const auto maxChars = (udLen - 32) / 2;
            while (pathLen < maxChars && pathLen < 1023 && p[pathLen] != L'\0') {
                pathBuf[pathLen] = p[pathLen];
                pathLen++;
            }
        }
        if (pathLen == 0) {
            self->etwWithoutPath.fetch_add(1, std::memory_order_relaxed);
            return;
        }
        pathBuf[pathLen] = L'\0';

        // Translate device path and check scope using fixed arrays (no heap allocation).
        // First, try to translate device prefix to DOS drive letter.
        wchar_t translatedPath[1024];
        std::size_t translatedLen = 0;
        bool translated = false;
        if (pathLen >= 9 && pathBuf[0] == L'\\' && pathBuf[1] == L'D') {
            for (std::size_t idx = 0; idx < self->devicePrefixCount; ++idx) {
                const std::size_t devLen = self->devicePrefixesFixed[idx].deviceLen;
                if (pathLen > devLen && pathBuf[devLen] == L'\\') {
                    bool match = true;
                    for (std::size_t i = 0; i < devLen; i++) {
                        wchar_t pc = pathBuf[i];
                        wchar_t dc = self->devicePrefixesFixed[idx].device[i];
                        // Case-insensitive compare
                        if (pc >= L'A' && pc <= L'Z') pc += L'a' - L'A';
                        if (dc >= L'A' && dc <= L'Z') dc += L'a' - L'A';
                        if (pc != dc) { match = false; break; }
                    }
                    if (match) {
                        // Copy drive letter (e.g., "C:")
                        const std::size_t driveLen = self->devicePrefixesFixed[idx].driveLen;
                        translatedLen = driveLen;
                        for (std::size_t i = 0; i < translatedLen; i++) {
                            translatedPath[i] = self->devicePrefixesFixed[idx].drive[i];
                        }
                        // Copy rest of path
                        std::size_t remaining = pathLen - devLen;
                        if (translatedLen + remaining < 1024) {
                            for (std::size_t i = 0; i < remaining; i++) {
                                translatedPath[translatedLen + i] = pathBuf[devLen + i];
                            }
                            translatedLen += remaining;
                            translatedPath[translatedLen] = L'\0';
                            translated = true;
                        }
                        break;
                    }
                }
            }
        }
        if (!translated) {
            // No device prefix match, use path as-is
            translatedLen = pathLen;
            for (std::size_t i = 0; i < translatedLen; i++) {
                translatedPath[i] = pathBuf[i];
            }
            translatedPath[translatedLen] = L'\0';
        }

        // Check if translated path starts with etwTargetRoot (case-insensitive, path-aware)
        // etwTargetRootFixed is like "C:\watched" (no trailing backslash, lowercase)
        // translatedPath is like "C:\watched\file.txt" (mixed case)
        bool inScope = false;
        std::size_t rootLen = self->etwTargetRootFixedLen;
        if (translatedLen >= rootLen) {
            bool match = true;
            for (std::size_t i = 0; i < rootLen; i++) {
                wchar_t tc = translatedPath[i];
                wchar_t rc = self->etwTargetRootFixed[i];
                // Case-insensitive compare (translatedPath may have mixed case)
                if (tc >= L'A' && tc <= L'Z') tc += L'a' - L'A';
                // rc is already lowercase
                if (tc != rc) { match = false; break; }
            }
            if (match) {
                // Exact match or path is deeper (next char is backslash)
                if (translatedLen == rootLen || translatedPath[rootLen] == L'\\') {
                    inScope = true;
                }
            }
        }
        if (!inScope) {
            self->etwOutOfScope.fetch_add(1, std::memory_order_relaxed);
            return;
        }
        self->etwAfterScope.fetch_add(1, std::memory_order_relaxed);

        const std::uint16_t kind = map_kind(opcode, provider);
        if (kind == 0) {
            self->etwKindZero.fetch_add(1, std::memory_order_relaxed);
            return;
        }
        self->etwAfterKind.fetch_add(1, std::memory_order_relaxed);

        std::uint64_t irpPtr = 0;
        if (ud && udLen >= 16) {
            irpPtr = *reinterpret_cast<const std::uint64_t*>(ud + 8);
        }

        // Extract Create-specific fields (only meaningful for op=64).
        std::uint32_t createOpts = 0, createDisp = 0, shareAccess = 0;
        // TEMP: Disable this - it crashes
        // if (isFileIo && opcode == 64 && udLen >= 28) {
        //     createOpts  = *reinterpret_cast<const std::uint32_t*>(ud + 16);
        //     createDisp  = *reinterpret_cast<const std::uint32_t*>(ud + 20);
        //     shareAccess = *reinterpret_cast<const std::uint32_t*>(ud + 24);
        // }

        LARGE_INTEGER qpc{}, freq{};
        QueryPerformanceCounter(&qpc);
        QueryPerformanceFrequency(&freq);
        const std::uint64_t ts = qpc_to_ns(qpc, freq);

        // Use RawEtwSlot for fast callback encoding
        RawEtwSlot rawSlot;
        encode_raw_slot(&rawSlot,
            HARIL_SOURCE_ETW, kind, ts,
            rec->EventHeader.ProcessId,
            rec->EventHeader.ThreadId,
            irpPtr, 0, nullptr, 0, 0, 0,
            shareAccess, createOpts, createDisp,
            static_cast<std::uint32_t>(self->etwEventsObserved.load()),
            pathBuf, pathLen,  // use the device path directly; translate at decode time
            L"", 0);
        // Push raw bytes to ring buffer - check if still running
        if (!self->etwRunning.load(std::memory_order_relaxed)) return;
        self->etwPushAttempted.fetch_add(1, std::memory_order_relaxed);
        if (!self->ring.push(std::span<const std::uint8_t>(
                reinterpret_cast<const std::uint8_t*>(&rawSlot),
                sizeof(RawEtwSlot)))) {
            self->etwRingPushFailed.fetch_add(1, std::memory_order_relaxed);
        }
    }

    static ULONG WINAPI EtwBufferCallback(PEVENT_TRACE_LOGFILEW buf) {
        if (buf->LogfileHeader.EventsLost > 0) {
            auto* self = static_cast<Impl*>(buf->Context);
            if (self) {
                self->etwEventsLost.fetch_add(
                    buf->LogfileHeader.EventsLost, std::memory_order_relaxed);
            }
        }
        return TRUE;
    }

    // Translate an NT device path (L"\\Device\\HarddiskVolumeN\\...")
    // to a DOS drive path (L"C:\\...") using the map built at start.
    // Returns the input unchanged when no prefix matches.
    std::wstring translate_device_path(std::wstring_view p) {
        if (p.size() < 9 || p[0] != L'\\' || p[1] != L'D') return std::wstring(p);
        for (const auto& [device, drive] : devicePrefixMap) {
            if (p.size() > device.size() &&
                p.compare(0, device.size(), device) == 0 &&
                p[device.size()] == L'\\') {
                return drive + std::wstring(p.substr(device.size()));
            }
        }
        return std::wstring(p);
    }

    void build_device_map() {
        devicePrefixMap.clear();
        devicePrefixCount = 0;
        wchar_t drives[256] = {0};
        DWORD n = GetLogicalDriveStringsW(256, drives);
        for (wchar_t* d = drives; n > 0 && *d; d += wcslen(d) + 1) {
            // d is like L"C:\\"; QueryDosDevice wants L"C:".
            std::wstring letter(d, 2);
            wchar_t target[512] = {0};
            if (QueryDosDeviceW(letter.c_str(), target, 512)) {
                devicePrefixMap.emplace_back(target, letter);
                // Also populate fixed array for callback
                if (devicePrefixCount < 32) {
                    std::size_t devLen = wcslen(target);
                    if (devLen < 256) {
                        wcscpy_s(devicePrefixesFixed[devicePrefixCount].device, target);
                        devicePrefixesFixed[devicePrefixCount].deviceLen = devLen;
                        std::size_t drvLen = wcslen(letter.c_str());
                        if (drvLen < 8) {
                            wcscpy_s(devicePrefixesFixed[devicePrefixCount].drive, letter.c_str());
                            devicePrefixesFixed[devicePrefixCount].driveLen = drvLen;
                            devicePrefixCount++;
                        }
                    }
                }
            }
        }
    }

    void etw_thread_entry() {
        std::vector<wchar_t> nameBuf;
        LPWSTR namePtr = nullptr;
        if (!etwSessionName.empty()) {
            nameBuf.assign(etwSessionName.begin(), etwSessionName.end());
            nameBuf.push_back(L'\0');
            namePtr = nameBuf.data();
        }

        EVENT_TRACE_LOGFILEW log{};
        log.LoggerName = namePtr;
        log.ProcessTraceMode = PROCESS_TRACE_MODE_EVENT_RECORD | PROCESS_TRACE_MODE_REAL_TIME;
        log.EventRecordCallback = EtwEventCallback;
        log.BufferCallback = EtwBufferCallback;
        log.Context = this;

        etwConsumerHandle = OpenTraceW(&log);
        if (etwConsumerHandle == INVALID_PROCESSTRACE_HANDLE) return;

        // Run ProcessTrace directly in this thread (not a nested jthread).
        // ProcessTrace will return when CloseTrace is called from etw_stop.
        ProcessTrace(&etwConsumerHandle, 1, nullptr, nullptr);

        etwConsumerHandle = INVALID_PROCESSTRACE_HANDLE;
    }

    int32_t etw_start(std::wstring_view session, std::wstring_view root) {
        if (etwRunning) return -1;
        // The NT Kernel Logger only accepts its canonical session name.
        // A custom name yields ERROR_INVALID_PARAMETER (87) on StartTraceW.
        // We keep the caller's name for reporting but always start (or
        // attach to) the canonical session.
        static constexpr wchar_t kKernelLoggerName[] = L"NT Kernel Logger";
        const std::wstring_view canonical(kKernelLoggerName);
        etwSessionName.assign(canonical.begin(), canonical.end());
        etwTargetRoot.assign(root.begin(), root.end());
        // Populate fixed buffer for callback (lowercase, no trailing backslash)
        etwTargetRootFixedLen = 0;
        for (std::size_t i = 0; i < root.size() && etwTargetRootFixedLen < 511; i++) {
            wchar_t c = root[i];
            if (c >= L'A' && c <= L'Z') c += L'a' - L'A';
            if (etwTargetRootFixedLen > 0 && c == L'\\' && etwTargetRootFixed[etwTargetRootFixedLen - 1] == L'\\') {
                // Skip duplicate backslash
                continue;
            }
            etwTargetRootFixed[etwTargetRootFixedLen++] = c;
        }
        // Remove trailing backslash
        if (etwTargetRootFixedLen > 0 && etwTargetRootFixed[etwTargetRootFixedLen - 1] == L'\\') {
            etwTargetRootFixedLen--;
        }
        etwTargetRootFixed[etwTargetRootFixedLen] = L'\0';
        (void)session;  // retained in the signature for file-session support

        constexpr std::size_t kReserved = 32;
        const std::size_t cb = sizeof(EVENT_TRACE_PROPERTIES) +
                              (canonical.size() + 1) * sizeof(wchar_t) +
                              kReserved * sizeof(wchar_t);
        std::vector<std::uint8_t> buf(cb);
        auto* p = reinterpret_cast<EVENT_TRACE_PROPERTIES*>(buf.data());
        ZeroMemory(p, sizeof(*p));
        p->Wnode.BufferSize    = static_cast<std::uint32_t>(cb);
        p->Wnode.Flags         = WNODE_FLAG_TRACED_GUID;
        p->Wnode.Guid          = SystemTraceControlGuidLocal;
        p->Wnode.ClientContext = 1;
        p->LogFileMode         = EVENT_TRACE_REAL_TIME_MODE;
        p->FlushTimer          = 1;
        p->EnableFlags         = EVENT_TRACE_FLAG_PROCESS | EVENT_TRACE_FLAG_THREAD
                                | EVENT_TRACE_FLAG_IMAGE_LOAD | EVENT_TRACE_FLAG_DISK_FILE_IO
                                | EVENT_TRACE_FLAG_FILE_IO | EVENT_TRACE_FLAG_FILE_IO_INIT;
        p->LoggerNameOffset    = sizeof(EVENT_TRACE_PROPERTIES);
        p->LogFileNameOffset   = 0;
        // The session name string must live inside the properties buffer
        // at LoggerNameOffset; StartTraceW reads it from there.
        {
            wchar_t* nameDst = reinterpret_cast<wchar_t*>(
                buf.data() + sizeof(EVENT_TRACE_PROPERTIES));
            std::memcpy(nameDst, canonical.data(), canonical.size() * sizeof(wchar_t));
            nameDst[canonical.size()] = L'\0';
        }

        const std::uint32_t r = StartTraceW(&etwSessionHandle,
                                            etwSessionName.c_str(), p);
        if (r != ERROR_SUCCESS && r != ERROR_ALREADY_EXISTS) {
            etwSessionHandle = 0;
            return static_cast<int32_t>(r);
        }
        // If another tool already owns the NT Kernel Logger session we
        // attach as a consumer instead of controlling it: we never stop
        // a session we did not start.
        etwOwnsSession = (r == ERROR_SUCCESS);

        etwRunning = true;
        etwStopRequested = false;
        build_device_map();
        etwThread = std::jthread([this]() noexcept { etw_thread_entry(); });
        return 0;
    }

    int32_t etw_stop() {
        if (!etwRunning) return 0;
        etwRunning = false;
        etwStopRequested = true;

        if (etwConsumerHandle != INVALID_PROCESSTRACE_HANDLE) {
            CloseTrace(etwConsumerHandle);
            etwConsumerHandle = INVALID_PROCESSTRACE_HANDLE;
        }
        if (etwThread.joinable()) etwThread.join();
        if (etwSessionHandle && etwOwnsSession) {
            EVENT_TRACE_PROPERTIES p{};
            p.Wnode.BufferSize = sizeof(p);
            p.LoggerNameOffset = sizeof(p);
            ControlTraceW(etwSessionHandle, etwSessionName.c_str(),
                          &p, EVENT_TRACE_CONTROL_STOP);
            // Session statistics (per "Controlling Event Tracing Sessions"):
            // merge final counters so the manifest reports total loss even
            // for events dropped before the last BufferCallback ran.
            std::uint64_t lost = etwEventsLost.load();
            if (p.EventsLost > lost) etwEventsLost.store(p.EventsLost);
            etwBuffersWritten.store(p.BuffersWritten);
            etwSessionHandle = 0;
        }
        etwOwnsSession = false;
        return 0;
    }

    // USN
    void usn_thread_entry() {
        std::vector<std::uint8_t> buf(1024 * 1024);
        while (!usnStopRequested.load()) {
            USN nextUsn;
            READ_USN_JOURNAL_DATA_V0 in{};
            in.StartUsn     = static_cast<USN>(usnCursor);
            in.ReasonMask   = 0xFFFFFFFF;
            in.UsnJournalID = usnJournal.UsnJournalID;

            std::uint32_t got = 0;
            const BOOL ok = DeviceIoControl(usnVolumeHandle.get(),
                                            FSCTL_READ_USN_JOURNAL,
                                            &in, sizeof(in), buf.data(),
                                            static_cast<std::uint32_t>(buf.size()),
                                            reinterpret_cast<LPDWORD>(&got), nullptr);
            if (!ok) break;
            if (got < sizeof(USN)) break;

            nextUsn = *reinterpret_cast<USN*>(buf.data());
            if (nextUsn <= in.StartUsn) {
                Sleep(50);
                continue;
            }

            std::uint8_t* p = buf.data() + sizeof(USN);
            std::uint8_t* end = buf.data() + got;
            while (p + sizeof(USN_RECORD_V2) <= end) {
                const auto* r = reinterpret_cast<const USN_RECORD_V2*>(p);
                if (r->RecordLength == 0) break;
                if (p + r->RecordLength > end) break;

                const std::uint64_t frn =
                    static_cast<std::uint64_t>(r->FileReferenceNumber);
                std::wstring resolved = resolve_frn_path(frn);
                if (resolved.empty()) {
                    // File already gone or not ours to name: drop the
                    // record but count it so coverage stays honest.
                    usnDroppedUnresolved.fetch_add(1, std::memory_order_relaxed);
                    p += r->RecordLength;
                    continue;
                }
                if (!usnTargetRoot.empty() && !path_starts_with(resolved, usnTargetRoot)) {
                    p += r->RecordLength;
                    continue;
                }

                std::uint8_t slotBuf[HARIL_SLOT_SIZE];
                std::span<std::uint8_t, HARIL_SLOT_SIZE> slot(slotBuf);
                LARGE_INTEGER qpc{}, freq{};
                QueryPerformanceCounter(&qpc);
                QueryPerformanceFrequency(&freq);
                const std::uint64_t ts = qpc_to_ns(qpc, freq);

                encode_event_slot(slot, HARIL_SOURCE_USN, kKindNotify, ts,
                                  0, 0, 0, 0, nullptr, 0,
                                  0, 0, 0, 0, 0,
                                  static_cast<std::uint32_t>(usnRecordsRead.load()),
                                  resolved, L"");
                encode_usn_extension(slot,
                    frn,
                    static_cast<std::uint64_t>(r->ParentFileReferenceNumber),
                    static_cast<std::uint64_t>(r->Usn),
                    static_cast<std::uint32_t>(r->Reason));
                ring.push(slot);
                usnRecordsRead.fetch_add(1);

                p += r->RecordLength;
            }
            usnCursor = static_cast<std::uint64_t>(nextUsn);
            Sleep(20);
        }
    }

    // Resolve an FRN to its current DOS path (L"C:\\..."). Empty when
    // the file cannot be opened (deleted, transient) — callers drop it.
    std::wstring resolve_frn_path(std::uint64_t frn) {
        FILE_ID_DESCRIPTOR fid{};
        fid.dwSize = sizeof(fid);
        fid.Type = FileIdType;
        fid.FileId.QuadPart = static_cast<LONGLONG>(frn);
        UniqueHandle h(make_unique(OpenFileById(
            usnVolumeHandle.get(), &fid,
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            nullptr, 0)));
        if (!h) return {};
        // VOLUME_NAME_DOS yields L"C:\\dir\\file" without the \\?\ prefix.
        std::vector<wchar_t> out(1024);
        DWORD len = GetFinalPathNameByHandleW(h.get(), out.data(),
                                              static_cast<DWORD>(out.size()),
                                              VOLUME_NAME_DOS);
        if (len == 0 || len >= out.size()) return {};
        return std::wstring(out.data(), len);
    }

    int32_t usn_start(std::wstring_view volume, std::wstring_view root) {
        if (usnRunning) return -1;
        usnVolume.assign(volume.begin(), volume.end());
        usnTargetRoot.assign(root.begin(), root.end());
        usnVolumeHandle = make_unique(CreateFileW(
            std::wstring(volume).c_str(), GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            nullptr, OPEN_EXISTING, 0, nullptr));
        if (!usnVolumeHandle) return GetLastError();

        std::uint32_t bytes = 0;
        if (!DeviceIoControl(usnVolumeHandle.get(), FSCTL_QUERY_USN_JOURNAL,
                             nullptr, 0, &usnJournal, sizeof(usnJournal),
                             reinterpret_cast<LPDWORD>(&bytes), nullptr)) {
            const std::uint32_t e = GetLastError();
            usnVolumeHandle.reset();
            return static_cast<int32_t>(e);
        }

        // Start reading at the journal head: only records written while
        // we watch are in scope. (Starting at 0 would replay history.)
        usnCursor = static_cast<std::uint64_t>(usnJournal.NextUsn);
        usnRunning = true;
        usnStopRequested = false;
        usnThread = std::jthread([this]() noexcept { usn_thread_entry(); });
        return 0;
    }

    int32_t usn_stop() {
        if (!usnRunning) return 0;
        usnRunning = false;
        usnStopRequested = true;
        if (usnThread.joinable()) usnThread.join();
        usnVolumeHandle.reset();
        return 0;
    }

    // Inventory
    int32_t inventory_walk(std::wstring_view root, int /*is_initial*/,
                            int (*emit_cb)(const std::uint8_t*, std::int32_t, void*),
                            void* user) {
        if (!emit_cb) return -1;
        std::vector<InventoryEmitRecord> recs;
        walk_dir_recursive(root, recs);
        for (const auto& r : recs) {
            std::vector<std::uint8_t> buf(sizeof(InventoryEmitRecord) + r.pathLen * 2);
            std::memcpy(buf.data(), &r, sizeof(InventoryEmitRecord));
            emit_cb(buf.data(), static_cast<std::int32_t>(buf.size()), user);
        }
        return static_cast<std::int32_t>(recs.size());
    }

    int32_t drain(std::uint8_t* out_buf, std::int32_t max_slots,
                   std::uint64_t* out_seq) {
        std::uint64_t seq = 0;
        // Pop raw slots into a temporary buffer
        const int n = ring.pop_batch(
            std::span<std::uint8_t>(out_buf, static_cast<std::size_t>(max_slots) * HARIL_SLOT_SIZE),
            &seq);
        // Decode each raw slot in-place to the full HARIL_SLOT_SIZE format
        for (int i = 0; i < n; i++) {
            std::uint8_t* slot = out_buf + static_cast<std::size_t>(i) * HARIL_SLOT_SIZE;
            // Check if this is a raw ETW slot (source == HARIL_SOURCE_ETW)
            const std::uint16_t source = *reinterpret_cast<std::uint16_t*>(slot);
            if (source == HARIL_SOURCE_ETW) {
                const RawEtwSlot* raw = reinterpret_cast<const RawEtwSlot*>(slot);
                // Use a temp buffer to decode, then copy back
                std::array<std::uint8_t, HARIL_SLOT_SIZE> decoded;
                decoded.fill(0);
                decode_raw_slot(raw, decoded);
                std::memcpy(slot, decoded.data(), HARIL_SLOT_SIZE);
            }
        }
        if (out_seq) *out_seq = seq;
        return n;
    }
};

// ----------------------- HarilContext facade -----------------------

HarilContext::HarilContext() : impl_(std::make_unique<Impl>()) {
    impl_->owner = this;
}

HarilContext::~HarilContext() {
    if (impl_->etwRunning) impl_->etw_stop();
    if (impl_->usnRunning) impl_->usn_stop();
}

int32_t HarilContext::etw_start(std::wstring_view session, std::wstring_view root) {
    return impl_->etw_start(session, root);
}
int32_t HarilContext::etw_stop()    { return impl_->etw_stop(); }
int32_t HarilContext::usn_start(std::wstring_view volume, std::wstring_view root) {
    return impl_->usn_start(volume, root);
}
int32_t HarilContext::usn_stop()    { return impl_->usn_stop(); }

int32_t HarilContext::inventory_walk(std::wstring_view root, int is_initial,
                                     int (*emit_cb)(const std::uint8_t*, std::int32_t, void*),
                                     void* user) {
    return impl_->inventory_walk(root, is_initial, emit_cb, user);
}

int32_t HarilContext::drain(std::uint8_t* out_buf, std::int32_t max_slots, std::uint64_t* out_seq) {
    return impl_->drain(out_buf, max_slots, out_seq);
}

std::vector<InventoryRow> HarilContext::walk_inventory(std::wstring_view root) {
    std::vector<InventoryRow> rows;
    walk_dir_rows(root, rows);
    return rows;
}

// ----------------------- Public accessors (defined here so Impl is complete) -------

bool    HarilContext::is_etw_running() const noexcept { return impl_->etwRunning; }
bool    HarilContext::is_usn_running() const noexcept { return impl_->usnRunning; }
std::uint64_t HarilContext::etw_events_lost() const noexcept { return impl_->etwEventsLost.load(); }
std::uint64_t HarilContext::etw_buffers_written() const noexcept { return impl_->etwBuffersWritten.load(); }
std::uint64_t HarilContext::etw_events_observed() const noexcept { return impl_->etwEventsObserved.load(); }
std::uint64_t HarilContext::etw_candidates_out_of_scope() const noexcept { return impl_->etwOutOfScope.load(); }
std::uint64_t HarilContext::etw_candidates_without_path() const noexcept { return impl_->etwWithoutPath.load(); }
std::uint64_t HarilContext::etw_ring_push_failed() const noexcept { return impl_->etwRingPushFailed.load(); }
std::uint64_t HarilContext::etw_push_attempted() const noexcept { return impl_->etwPushAttempted.load(); }
std::uint64_t HarilContext::etw_kind_zero() const noexcept { return impl_->etwKindZero.load(); }
std::uint64_t HarilContext::etw_after_kind() const noexcept { return impl_->etwAfterKind.load(); }
std::uint64_t HarilContext::etw_after_scope() const noexcept { return impl_->etwAfterScope.load(); }
std::uint64_t HarilContext::ring_head() const noexcept { return impl_->ring.head(); }
std::uint64_t HarilContext::ring_tail() const noexcept { return impl_->ring.tail(); }
std::uint64_t HarilContext::usn_dropped_unresolved() const noexcept { return impl_->usnDroppedUnresolved.load(); }
std::uint64_t HarilContext::usn_records_read() const noexcept { return impl_->usnRecordsRead.load(); }

std::uint64_t HarilContext::hash_guid(const GUID& g) noexcept {
    std::uint64_t h = 1469598103934665603ULL;
    const std::uint8_t* p = reinterpret_cast<const std::uint8_t*>(&g);
    for (std::size_t i = 0; i < sizeof(GUID); i++) {
        h ^= p[i];
        h *= 1099511628211ULL;
    }
    return h;
}

// ----------------------- Free functions for elevation / file-id -----------------------

namespace {

int32_t is_admin_impl() noexcept {
    BOOL isAdmin = FALSE;
    SID_IDENTIFIER_AUTHORITY NtAuthority = SECURITY_NT_AUTHORITY;
    PSID administratorsGroup = nullptr;
    if (!AllocateAndInitializeSid(&NtAuthority, 2, SECURITY_BUILTIN_DOMAIN_RID,
                                  DOMAIN_ALIAS_RID_ADMINS, 0, 0, 0, 0, 0, 0,
                                  &administratorsGroup)) {
        return 0;
    }
    CheckTokenMembership(nullptr, administratorsGroup, &isAdmin);
    FreeSid(administratorsGroup);
    return isAdmin ? 1 : 0;
}

int32_t relaunch_elevated_impl(std::wstring_view exe, std::wstring_view args) {
    const HRESULT hr = CoInitializeEx(nullptr,
        COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
    const bool coinitInited = SUCCEEDED(hr);

    const std::wstring exeStr(exe);
    const std::wstring argsStr(args);

    SHELLEXECUTEINFOW info{};
    info.cbSize       = sizeof(info);
    info.fMask        = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb       = L"runas";
    info.lpFile       = exeStr.c_str();
    info.lpParameters = argsStr.empty() ? nullptr : argsStr.c_str();
    info.nShow        = SW_SHOWNORMAL;

    const BOOL ok = ShellExecuteExW(&info);
    std::int32_t result;
    if (!ok) {
        result = static_cast<std::int32_t>(GetLastError());
    } else if (info.hProcess) {
        WaitForSingleObject(info.hProcess, INFINITE);
        DWORD code = 0;
        GetExitCodeProcess(info.hProcess, &code);
        CloseHandle(info.hProcess);
        result = static_cast<std::int32_t>(code);
    } else {
        result = 0;
    }

    if (coinitInited) CoUninitialize();
    return result;
}

int32_t get_file_id_impl(std::wstring_view path,
                          std::uint8_t* out_id16,
                          std::uint32_t* out_volume_serial) {
    const UniqueHandle h(make_unique(CreateFileW(
        std::wstring(path).c_str(), 0,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr)));
    if (!h) return GetLastError();
    FILE_ID_INFO id{};
    if (!GetFileInformationByHandleEx(h.get(), FileIdInfo, &id, sizeof(id))) {
        return GetLastError();
    }
    if (out_id16) std::memcpy(out_id16, id.FileId.Identifier, 16);
    if (out_volume_serial) *out_volume_serial = static_cast<std::uint32_t>(id.VolumeSerialNumber);
    return 0;
}

std::wstring utf16_from_buffer(const std::uint16_t* buf, int len) {
    if (len <= 0 || !buf) return {};
    return std::wstring(reinterpret_cast<const wchar_t*>(buf), static_cast<std::size_t>(len));
}

}  // namespace

// ----------------------- C exports -----------------------

extern "C" {

HarilContext* haril_open() {
    try {
        return new HarilContext();
    } catch (...) {
        return nullptr;
    }
}

void haril_close(HarilContext* ctx) {
    delete ctx;
}

int32_t haril_source_status(HarilContext* ctx, HarilSource src) {
    if (!ctx) return 0;
    switch (src) {
        case HARIL_SOURCE_ETW: return ctx->is_etw_running() ? 1 : 0;
        case HARIL_SOURCE_USN: return ctx->is_usn_running() ? 1 : 0;
        case HARIL_SOURCE_FSW: return 1;
    }
    return 0;
}

int32_t haril_etw_start(HarilContext* ctx,
                         const std::uint16_t* session_utf16, std::int32_t session_len,
                         const std::uint16_t* root_utf16,    std::int32_t root_len) {
    if (!ctx) return -1;
    return ctx->etw_start(utf16_from_buffer(session_utf16, session_len),
                          utf16_from_buffer(root_utf16, root_len));
}

int32_t haril_etw_stop(HarilContext* ctx) {
    if (!ctx) return -1;
    return ctx->etw_stop();
}

uint64_t haril_etw_events_lost(HarilContext* ctx) {
    return ctx ? ctx->etw_events_lost() : 0;
}

uint64_t haril_etw_buffers_written(HarilContext* ctx) {
    return ctx ? ctx->etw_buffers_written() : 0;
}

uint64_t haril_etw_events_observed(HarilContext* ctx) {
    return ctx ? ctx->etw_events_observed() : 0;
}

uint64_t haril_etw_candidates_out_of_scope(HarilContext* ctx) {
    return ctx ? ctx->etw_candidates_out_of_scope() : 0;
}

uint64_t haril_etw_candidates_without_path(HarilContext* ctx) {
    return ctx ? ctx->etw_candidates_without_path() : 0;
}

uint64_t haril_etw_ring_push_failed(HarilContext* ctx) {
    return ctx ? ctx->etw_ring_push_failed() : 0;
}

uint64_t haril_etw_push_attempted(HarilContext* ctx) {
    return ctx ? ctx->etw_push_attempted() : 0;
}

uint64_t haril_etw_kind_zero(HarilContext* ctx) {
    return ctx ? ctx->etw_kind_zero() : 0;
}

uint64_t haril_etw_after_kind(HarilContext* ctx) {
    return ctx ? ctx->etw_after_kind() : 0;
}

uint64_t haril_etw_after_scope(HarilContext* ctx) {
    return ctx ? ctx->etw_after_scope() : 0;
}

uint64_t haril_ring_head(HarilContext* ctx) {
    return ctx ? ctx->ring_head() : 0;
}

uint64_t haril_ring_tail(HarilContext* ctx) {
    return ctx ? ctx->ring_tail() : 0;
}

uint64_t haril_usn_dropped_unresolved(HarilContext* ctx) {
    return ctx ? ctx->usn_dropped_unresolved() : 0;
}

int32_t haril_usn_start(HarilContext* ctx,
                         const std::uint16_t* volume_utf16, std::int32_t volume_len,
                         const std::uint16_t* root_utf16, std::int32_t root_len) {
    if (!ctx) return -1;
    return ctx->usn_start(utf16_from_buffer(volume_utf16, volume_len),
                          utf16_from_buffer(root_utf16, root_len));
}

int32_t haril_usn_stop(HarilContext* ctx) {
    if (!ctx) return -1;
    return ctx->usn_stop();
}

uint64_t haril_usn_records_read(HarilContext* ctx) {
    return ctx ? ctx->usn_records_read() : 0;
}

int32_t haril_inventory_walk(HarilContext* ctx,
                             const std::uint16_t* root_utf16, std::int32_t root_len,
                             int is_initial,
                             int (*emit_cb)(const std::uint8_t*, std::int32_t, void*),
                             void* user) {
    if (!ctx) return -1;
    return ctx->inventory_walk(utf16_from_buffer(root_utf16, root_len),
                                is_initial, emit_cb, user);
}

int32_t haril_get_file_id(const std::uint16_t* path_utf16, std::int32_t path_len,
                           std::uint8_t* out_id16, std::uint32_t* out_volume_serial) {
    return get_file_id_impl(utf16_from_buffer(path_utf16, path_len),
                            out_id16, out_volume_serial);
}

int32_t haril_is_admin() {
    return is_admin_impl();
}

int32_t haril_relaunch_elevated(const std::uint16_t* exe_utf16, std::int32_t exe_len,
                                  const std::uint16_t* args_utf16, std::int32_t args_len) {
    return relaunch_elevated_impl(
        utf16_from_buffer(exe_utf16, exe_len),
        utf16_from_buffer(args_utf16, args_len));
}

int32_t haril_drain(HarilContext* ctx, std::uint8_t* out_buf,
                     std::int32_t max_slots, std::uint64_t* out_seq_high) {
    if (!ctx) return 0;
    return ctx->drain(out_buf, max_slots, out_seq_high);
}

}  /* extern "C" */