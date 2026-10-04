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

constexpr std::size_t kRingCapacity = 65536;  // 64k slots x 1 KiB = 64 MiB
constexpr std::size_t kRingBytes   = kRingCapacity * HARIL_SLOT_SIZE;
// Longest path a record can carry (UNICODE_STRING limit) and the number
// of UTF-16 units per continuation slot.
constexpr std::size_t kMaxRecordPathChars = 32767;
constexpr std::size_t kContChars = HARIL_SLOT_SIZE / 2;

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

    // Push one logical record: `header` is a full public-layout slot
    // (path fields are filled here). Paths longer than the inline area
    // spill into continuation slots of raw UTF-16. The whole record is
    // claimed atomically with a CAS so a full ring never leaves an
    // unpublished hole behind (which would stall the consumer).
    bool push_record(const std::uint8_t* header, const wchar_t* path, std::size_t pathLen) noexcept {
        if (pathLen > kMaxRecordPathChars) pathLen = kMaxRecordPathChars;
        const std::size_t inlineChars = std::min<std::size_t>(pathLen, HARIL_SLOT_PATH_CHARS);
        const std::size_t rest = pathLen - inlineChars;
        const std::size_t extra = (rest + kContChars - 1) / kContChars;
        const std::uint64_t k = 1 + extra;

        std::uint64_t seq = head_seq_.v.load(std::memory_order_relaxed);
        for (;;) {
            const std::uint64_t t = tail_seq_.v.load(std::memory_order_acquire);
            if (seq + k - t > kRingCapacity) return false;  // backpressure: drop whole record
            if (head_seq_.v.compare_exchange_weak(seq, seq + k,
                    std::memory_order_acq_rel, std::memory_order_relaxed)) {
                break;
            }
        }

        // Continuation slots first; the head slot is published last.
        for (std::uint64_t j = 1; j < k; j++) {
            const std::size_t index = (seq + j) % kRingCapacity;
            std::uint8_t* dst = storage_ + index * HARIL_SLOT_SIZE;
            const std::size_t off = inlineChars + (j - 1) * kContChars;
            const std::size_t n = std::min<std::size_t>(kContChars, pathLen - off);
            std::memcpy(dst, path + off, n * sizeof(wchar_t));
            if (n < kContChars) std::memset(dst + n * 2, 0, HARIL_SLOT_SIZE - n * 2);
            available_[index].store(seq + j + 1, std::memory_order_release);
        }

        const std::size_t index = seq % kRingCapacity;
        std::uint8_t* dst = storage_ + index * HARIL_SLOT_SIZE;
        std::memcpy(dst, header, HARIL_SLOT_SIZE);
        std::memset(dst + HARIL_SLOT_PATH_OFFSET, 0, HARIL_SLOT_PATH_CHARS * 2);
        std::memcpy(dst + HARIL_SLOT_PATH_OFFSET, path, inlineChars * sizeof(wchar_t));
        *reinterpret_cast<std::uint16_t*>(dst + 76) = static_cast<std::uint16_t>(pathLen);
        *reinterpret_cast<std::uint16_t*>(dst + 80) = static_cast<std::uint16_t>(extra);
        available_[index].store(seq + 1, std::memory_order_release);
        return true;
    }

    // Pop whole records only: a record is taken when its head and all of
    // its continuation slots are published and fit in `out`.
    int pop_batch(std::span<std::uint8_t> out, std::uint64_t* out_seq) noexcept {
        const std::uint64_t t = tail_seq_.v.load(std::memory_order_relaxed);
        const int max_slots = static_cast<int>(out.size() / HARIL_SLOT_SIZE);
        int n = 0;

        while (n < max_slots) {
            const std::uint64_t seq = t + n;
            const std::size_t index = seq % kRingCapacity;
            if (available_[index].load(std::memory_order_acquire) != seq + 1) break;
            const std::uint8_t* head = storage_ + index * HARIL_SLOT_SIZE;
            const int k = 1 + *reinterpret_cast<const std::uint16_t*>(head + 80);
            if (n + k > max_slots) break;
            bool complete = true;
            for (int j = 1; j < k; j++) {
                const std::size_t ji = (seq + j) % kRingCapacity;
                if (available_[ji].load(std::memory_order_acquire) != seq + j + 1) {
                    complete = false;
                    break;
                }
            }
            if (!complete) break;
            for (int j = 0; j < k; j++) {
                const std::size_t ji = (seq + j) % kRingCapacity;
                std::memcpy(out.data() + static_cast<std::size_t>(n + j) * HARIL_SLOT_SIZE,
                            storage_ + ji * HARIL_SLOT_SIZE, HARIL_SLOT_SIZE);
            }
            n += k;
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

// ----------------------- Slot encoding -----------------------
//
// Public slot layout (little-endian), shared by ETW and USN producers;
// see packages/core/src/ffi/ring_consumer.ts for the consumer side:
//   [0..76)    fixed header (source, kind, ts, pid, tid, irp, status,
//              fileId128, vsn, byteOffset, byteLen, share, createOpts,
//              createDisp, sourceIdx)
//   [76..78)   pathLen   u16  total UTF-16 units of the observed path
//   [78..80)   procLen   u16  UTF-16 units of the process image name
//   [80..82)   extra     u16  continuation slots following this one
//   [112..176) process image name (UTF-16, HARIL_SLOT_PROC_CHARS)
//   [176..204) USN extension (USN slots only)
//   [256..1024) first HARIL_SLOT_PATH_CHARS units of the path
// Continuation slots carry the rest of the path as raw UTF-16
// (HARIL_SLOT_SIZE / 2 units each).

// Write a UTF-16 string into the slot at `offset`, bounded by
// `max_chars`, and store its length (u16) at `len_offset`.
inline void put_slot_string(std::uint8_t* p, std::size_t offset, std::size_t max_chars,
                            std::size_t len_offset, const wchar_t* s, std::size_t n) noexcept {
    if (n > max_chars) n = max_chars;
    std::memset(p + offset, 0, max_chars * 2);
    std::memcpy(p + offset, s, n * sizeof(wchar_t));
    *reinterpret_cast<std::uint16_t*>(p + len_offset) = static_cast<std::uint16_t>(n);
}
// USN extension block, written into the slot's reserved area by the USN
// producer thread only. Layout (little-endian):
//   [176..184] fileReferenceNumber       u64
//   [184..192] parentFileReferenceNumber u64
//   [192..200] usn                       u64
//   [200..204] reason                    u32
// [204..256) still reserved.

// Slot encoding for non-callback paths (USN, inventory, etc.)
inline void encode_event_slot(std::span<std::uint8_t, HARIL_SLOT_SIZE> s,
                       std::uint16_t source, std::uint16_t kind, std::uint64_t ts_ns,
                       std::uint32_t pid, std::uint32_t tid, std::uint64_t irp, std::uint32_t ntStatus,
                       const std::uint8_t fileId[16], std::uint32_t vsn,
                       std::uint32_t byteOffset, std::uint32_t byteLen,
                       std::uint32_t shareAccess, std::uint32_t createOpts, std::uint32_t createDisp,
                       std::uint32_t sourceIdx,
                       std::wstring_view proc) noexcept {
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
    put_slot_string(p, HARIL_SLOT_PROC_OFFSET, HARIL_SLOT_PROC_CHARS, 78, proc.data(), proc.size());
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
constexpr std::uint16_t kKindRead   = 3;
constexpr std::uint16_t kKindSetInfo= 4;
constexpr std::uint16_t kKindWrite  = 5;
constexpr std::uint16_t kKindClose  = 6;
constexpr std::uint16_t kKindRename = 7;
constexpr std::uint16_t kKindDelete = 8;
constexpr std::uint16_t kKindOpEnd  = 9;
constexpr std::uint16_t kKindNotify = 10;

// ----------------------- ETW constants -----------------------

// Kernel FileIo MOF class (NT Kernel Logger): {90CBDC39-4A3E-11D1-84F4-0000F80464E3}.
constexpr GUID Microsoft_Windows_Kernel_File_MOF_GUID =
    { 0x90CBDC39, 0x4A3E, 0x11D1, { 0x84, 0xF4, 0x00, 0x00, 0xF8, 0x04, 0x64, 0xE3 } };

// SystemTraceControlGuid is exported by Advapi32.lib but its header
// definition is conditional on INITGUID.
constexpr GUID SystemTraceControlGuidLocal =
    { 0x9E814AAD, 0x3204, 0x11D2, { 0x9A, 0x82, 0x00, 0x60, 0x08, 0xA8, 0x69, 0x39 } };

// Strip the Win32 namespace prefix: L"\\\\?\\C:\\x" -> L"C:\\x",
// L"\\\\?\\UNC\\srv\\share" -> L"\\\\srv\\share".
std::wstring strip_long_prefix(std::wstring_view p) {
    if (p.size() >= 8 && p.substr(0, 8) == L"\\\\?\\UNC\\") return L"\\" + std::wstring(p.substr(7));
    if (p.size() >= 4 && (p.substr(0, 4) == L"\\\\?\\" || p.substr(0, 4) == L"\\??\\")) return std::wstring(p.substr(4));
    return std::wstring(p);
}

// Win32 form usable beyond MAX_PATH regardless of the process manifest.
std::wstring to_long_path(std::wstring_view p) {
    if (p.size() >= 4 && (p.substr(0, 4) == L"\\\\?\\" || p.substr(0, 4) == L"\\\\.\\")) return std::wstring(p);
    if (p.size() >= 2 && p[0] == L'\\' && p[1] == L'\\') return L"\\\\?\\UNC\\" + std::wstring(p.substr(2));
    if (p.size() >= 3 && p[1] == L':' && (p[2] == L'\\' || p[2] == L'/')) {
        std::wstring out = L"\\\\?\\" + std::wstring(p);
        std::replace(out.begin(), out.end(), L'/', L'\\');
        return out;
    }
    return std::wstring(p);
}

// Lowercase, '\'-separated, without trailing backslash (so "C:\" -> "c:").
std::wstring lower_root_for_cmp(std::wstring_view s) {
    std::wstring out;
    out.reserve(s.size());
    for (wchar_t c : s) {
        const wchar_t x = c == L'/' ? L'\\' : static_cast<wchar_t>(towlower(c));
        if (x == L'\\' && !out.empty() && out.back() == L'\\') continue;
        out.push_back(x);
    }
    while (!out.empty() && out.back() == L'\\') out.pop_back();
    return out;
}

// Final (long-name, symlink-resolved) DOS path of an existing directory,
// e.g. "C:\Users\FRANCI~1\x" -> "C:\Users\francisco\x". Falls back to the
// input without its \\?\ prefix when the directory cannot be opened.
std::wstring canonical_dir_path(std::wstring_view p) {
    std::wstring fallback = strip_long_prefix(p);
    std::replace(fallback.begin(), fallback.end(), L'/', L'\\');
    HANDLE h = CreateFileW(to_long_path(fallback).c_str(), 0,
                           FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    if (h == INVALID_HANDLE_VALUE) return fallback;
    std::vector<wchar_t> buf(512);
    DWORD len = GetFinalPathNameByHandleW(h, buf.data(), static_cast<DWORD>(buf.size()), VOLUME_NAME_DOS);
    if (len >= buf.size()) {
        buf.resize(static_cast<std::size_t>(len) + 1);
        len = GetFinalPathNameByHandleW(h, buf.data(), static_cast<DWORD>(buf.size()), VOLUME_NAME_DOS);
    }
    CloseHandle(h);
    if (len == 0 || len >= buf.size()) return fallback;
    return strip_long_prefix(std::wstring_view(buf.data(), len));
}

// 8.3 short form of a path ("" when unavailable).
std::wstring short_path_alias(const std::wstring& p) {
    const std::wstring lp = to_long_path(p);
    const DWORD need = GetShortPathNameW(lp.c_str(), nullptr, 0);
    if (need == 0) return {};
    std::vector<wchar_t> buf(need);
    const DWORD len = GetShortPathNameW(lp.c_str(), buf.data(), need);
    if (len == 0 || len >= need) return {};
    return strip_long_prefix(std::wstring_view(buf.data(), len));
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
    const UniqueHandle h(make_unique(FindFirstFileW(to_long_path(pattern).c_str(), &fd)));
    if (!h) return;

    do {
        if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
        const std::wstring full = std::wstring(root) + L"\\" + fd.cFileName;
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            walk_dir_recursive(full, out);
            continue;
        }

        const UniqueHandle hf(make_unique(CreateFileW(
            to_long_path(full).c_str(), 0,
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
    const UniqueHandle h(make_unique(FindFirstFileW(to_long_path(pattern).c_str(), &fd)));
    if (!h) return;

    do {
        if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
        const std::wstring full = std::wstring(root) + L"\\" + fd.cFileName;
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            walk_dir_rows(full, out);
            continue;
        }

        const UniqueHandle hf(make_unique(CreateFileW(
            to_long_path(full).c_str(), 0,
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
    // Scope roots for the callback: lowercase, '\' separators, no trailing
    // backslash. The alias is the 8.3 short form of the canonical root
    // (empty when identical); matches on it are rewritten to the
    // canonical root so every emitted path shares one prefix.
    std::wstring etwRootLower;
    std::wstring etwRootAliasLower;
    // In-scope paths by FileObject (from Create) and by FileKey (from the
    // Name/Rundown events). Touched only on the ProcessTrace thread.
    static constexpr std::size_t kMaxTrackedHandles = 1u << 20;
    std::unordered_map<std::uint64_t, std::wstring> etwObjPaths;
    std::unordered_map<std::uint64_t, std::wstring> etwKeyPaths;
    // Directory spelled with 8.3 components -> long form ("" if unknown).
    std::unordered_map<std::wstring, std::wstring> etwLongDirCache;
    // Scratch buffer for the translated path. ProcessTrace delivers events
    // on a single thread, so the callback can reuse it without locking.
    wchar_t etwPathScratch[kMaxRecordPathChars + 1];
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

    // pid -> process image base name, filled by drain() (consumer thread).
    std::unordered_map<std::uint32_t, std::wstring> procNameCache;

    // USN
    std::wstring usnVolume;
    std::wstring usnTargetRoot;  // scope filter; empty = no filtering
    UniqueHandle usnVolumeHandle;
    USN_JOURNAL_DATA usnJournal{};
    std::uint64_t usnCursor = 0;  // next USN to read; set at start
    std::atomic<std::uint64_t> usnRecordsRead{0};
    std::uint32_t usnVolumeSerial = 0;
    std::unordered_map<std::uint64_t, std::wstring> usnDirCache;
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

    // ETW EventCallback — manual MOF parser for the NT Kernel Logger
    // FileIo events (TdhGetEventInformation returns 1168 for them).
    // Layouts with 8-byte pointers (x64/arm64), per the FileIo_* classes:
    //   64       Create      IrpPtr@0 FileObject@8 TTID@16 CreateOptions@20
    //                        FileAttributes@24 ShareAccess@28 OpenPath@32
    //   65/66    Cleanup/Close  IrpPtr@0 FileObject@8 FileKey@16 TTID@24
    //   67/68    Read/Write  Offset@0 IrpPtr@8 FileObject@16 FileKey@24
    //                        TTID@32 IoSize@36 IoFlags@40
    //   69/70/71 SetInfo/Delete/Rename  IrpPtr@0 FileObject@8 FileKey@16
    //                        ExtraInfo@24 TTID@32 InfoClass@36
    //   0/32/35/36 Name/FileCreate/FileDelete/FileRundown
    //                        FileKey@0 FileName@8
    // Only Create and the Name family carry a path; the other operations
    // are resolved through the FileObject seen at Create, or the FileKey
    // seen in a Name event (files opened before the capture started).
    static constexpr std::uint16_t kOpName = 0, kOpFileCreate = 32, kOpFileDelete = 35,
                                   kOpFileRundown = 36, kOpCreate = 64, kOpCleanup = 65,
                                   kOpClose = 66, kOpRead = 67, kOpWrite = 68,
                                   kOpSetInfo = 69, kOpDelete = 70, kOpRename = 71;

    // Reads a NUL-terminated UTF-16 path at `off`, translates the NT
    // device prefix and checks the scope. On success the canonical path
    // is in etwPathScratch[0..outLen).
    bool etw_scoped_path(const std::uint8_t* ud, std::size_t udLen, std::size_t off,
                         std::size_t& outLen) noexcept {
        if (udLen < off + 2) return false;
        const auto* src = reinterpret_cast<const wchar_t*>(ud + off);
        const std::size_t maxChars = std::min<std::size_t>((udLen - off) / 2, kMaxRecordPathChars);
        std::size_t pathLen = 0;
        while (pathLen < maxChars && src[pathLen] != L'\0') pathLen++;
        if (pathLen == 0) return false;

        // \Device\HarddiskVolumeN\... -> C:\... (unknown prefixes kept).
        wchar_t* out = etwPathScratch;
        outLen = 0;
        bool translated = false;
        if (pathLen >= 9 && src[0] == L'\\' && src[1] == L'D') {
            for (std::size_t idx = 0; idx < devicePrefixCount && !translated; ++idx) {
                const auto& dp = devicePrefixesFixed[idx];
                const std::size_t devLen = dp.deviceLen;
                if (pathLen <= devLen || src[devLen] != L'\\') continue;
                bool match = true;
                for (std::size_t i = 0; i < devLen; i++) {
                    if (towlower(src[i]) != towlower(dp.device[i])) { match = false; break; }
                }
                if (!match) continue;
                const std::size_t remaining = pathLen - devLen;
                if (dp.driveLen + remaining > kMaxRecordPathChars) break;
                std::memcpy(out, dp.drive, dp.driveLen * sizeof(wchar_t));
                std::memcpy(out + dp.driveLen, src + devLen, remaining * sizeof(wchar_t));
                outLen = dp.driveLen + remaining;
                translated = true;
            }
        }
        if (!translated) {
            std::memcpy(out, src, pathLen * sizeof(wchar_t));
            outLen = pathLen;
        }

        // Scope: the path must equal the root or live below it.
        auto under = [&](const std::wstring& root) {
            const std::size_t n = root.size();
            if (n == 0 || outLen < n) return false;
            for (std::size_t i = 0; i < n; i++) {
                if (towlower(out[i]) != root[i]) return false;
            }
            return outLen == n || out[n] == L'\\';
        };
        if (under(etwRootLower)) return true;
        if (under(etwRootAliasLower)) {
            // Opened through the 8.3 alias: rewrite to the canonical root.
            const std::size_t aliasLen = etwRootAliasLower.size();
            const std::size_t tail = outLen - aliasLen;
            if (etwTargetRoot.size() + tail > kMaxRecordPathChars) return false;
            std::memmove(out + etwTargetRoot.size(), out + aliasLen, tail * sizeof(wchar_t));
            std::memcpy(out, etwTargetRoot.data(), etwTargetRoot.size() * sizeof(wchar_t));
            outLen = etwTargetRoot.size() + tail;
            return true;
        }
        // Mixed short/long spellings (C:\Users\FRANCI~1\...\long-name\f):
        // expand the parent directory, which exists even when the leaf is
        // being created, and retry.
        if (std::find(out, out + outLen, L'~') == out + outLen) return false;
        std::size_t slash = outLen;
        while (slash > 0 && out[slash - 1] != L'\\') slash--;
        if (slash < 2) return false;
        const std::wstring dir(out, slash - 1);
        auto it = etwLongDirCache.find(dir);
        if (it == etwLongDirCache.end()) {
            if (etwLongDirCache.size() > 65536) etwLongDirCache.clear();
            std::wstring longDir;
            const std::wstring lp = to_long_path(dir);
            const DWORD need = GetLongPathNameW(lp.c_str(), nullptr, 0);
            if (need > 0) {
                std::vector<wchar_t> buf(need);
                const DWORD len = GetLongPathNameW(lp.c_str(), buf.data(), need);
                if (len > 0 && len < need) longDir = strip_long_prefix(std::wstring_view(buf.data(), len));
            }
            it = etwLongDirCache.emplace(dir, std::move(longDir)).first;
        }
        const std::wstring& longDir = it->second;
        if (longDir.empty() || longDir == dir) return false;
        const std::size_t tail = outLen - (slash - 1);
        if (longDir.size() + tail > kMaxRecordPathChars) return false;
        std::memmove(out + longDir.size(), out + slash - 1, tail * sizeof(wchar_t));
        std::memcpy(out, longDir.data(), longDir.size() * sizeof(wchar_t));
        outLen = longDir.size() + tail;
        return under(etwRootLower);
    }

    static std::uint64_t ud_u64(const std::uint8_t* ud, std::size_t off) noexcept {
        std::uint64_t v = 0;
        std::memcpy(&v, ud + off, sizeof(v));
        return v;
    }
    static std::uint32_t ud_u32(const std::uint8_t* ud, std::size_t off) noexcept {
        std::uint32_t v = 0;
        std::memcpy(&v, ud + off, sizeof(v));
        return v;
    }

    static VOID WINAPI EtwEventCallback(PEVENT_RECORD rec) {
        auto* self = static_cast<Impl*>(rec->UserContext);
        if (!self) return;
        if (self->etwStopRequested.load(std::memory_order_relaxed)) return;
        self->etwEventsObserved.fetch_add(1, std::memory_order_relaxed);

        const GUID& provider = rec->EventHeader.ProviderId;
        const bool isFileIo = (provider == Microsoft_Windows_Kernel_File_MOF_GUID) ||
                              (provider.Data1 == 0x90CBDC39);
        if (!isFileIo) return;
        // 32-bit producers use 4-byte pointers; every layout above assumes 8.
        if (rec->EventHeader.Flags & EVENT_HEADER_FLAG_32_BIT_HEADER) return;

        const auto* ud = static_cast<const std::uint8_t*>(rec->UserData);
        const std::size_t udLen = rec->UserDataLength;
        if (!ud) return;
        const std::uint16_t opcode = rec->EventHeader.EventDescriptor.Opcode;

        std::size_t outLen = 0;
        std::uint16_t kind = 0;
        std::uint64_t irpPtr = 0;
        std::uint64_t byteOffset = 0;
        std::uint32_t byteLen = 0, shareAccess = 0, createOpts = 0, createDisp = 0;
        const wchar_t* path = nullptr;

        switch (opcode) {
            case kOpName: case kOpFileCreate: case kOpFileRundown: {
                if (udLen < 10) return;
                const std::uint64_t key = ud_u64(ud, 0);
                if (self->etw_scoped_path(ud, udLen, 8, outLen)) {
                    if (self->etwKeyPaths.size() > kMaxTrackedHandles) self->etwKeyPaths.clear();
                    self->etwKeyPaths.insert_or_assign(key, std::wstring(self->etwPathScratch, outLen));
                } else {
                    self->etwKeyPaths.erase(key);
                }
                return;
            }
            case kOpFileDelete: {
                if (udLen >= 8) self->etwKeyPaths.erase(ud_u64(ud, 0));
                return;
            }
            case kOpCreate: {
                if (udLen < 34) { self->etwWithoutPath.fetch_add(1, std::memory_order_relaxed); return; }
                irpPtr = ud_u64(ud, 0);
                const std::uint64_t fileObject = ud_u64(ud, 8);
                const std::uint32_t options = ud_u32(ud, 20);
                shareAccess = ud_u32(ud, 28);
                createOpts = options & 0x00FFFFFFu;
                createDisp = options >> 24;
                if (!self->etw_scoped_path(ud, udLen, 32, outLen)) {
                    self->etwObjPaths.erase(fileObject);
                    self->etwOutOfScope.fetch_add(1, std::memory_order_relaxed);
                    return;
                }
                if (self->etwObjPaths.size() > kMaxTrackedHandles) self->etwObjPaths.clear();
                self->etwObjPaths.insert_or_assign(fileObject, std::wstring(self->etwPathScratch, outLen));
                path = self->etwPathScratch;
                // FILE_OPEN (1) / FILE_OPEN_IF (3) on an existing file is an
                // open; actual creation is confirmed by USN and the inventories.
                kind = (createDisp == 1 || createDisp == 3) ? kKindOpen : kKindCreate;
                break;
            }
            case kOpCleanup:
                return;  // Close follows; one end-of-handle event is enough.
            case kOpClose: case kOpRead: case kOpWrite:
            case kOpSetInfo: case kOpDelete: case kOpRename: {
                const bool rw = opcode == kOpRead || opcode == kOpWrite;
                const std::size_t objOff = rw ? 16 : 8;
                if (udLen < objOff + 16) return;
                irpPtr = ud_u64(ud, rw ? 8 : 0);
                const std::uint64_t fileObject = ud_u64(ud, objOff);
                const std::uint64_t fileKey = ud_u64(ud, objOff + 8);
                const std::wstring* known = nullptr;
                if (auto it = self->etwObjPaths.find(fileObject); it != self->etwObjPaths.end()) {
                    known = &it->second;
                } else if (auto kt = self->etwKeyPaths.find(fileKey); kt != self->etwKeyPaths.end()) {
                    known = &kt->second;
                }
                if (!known) {
                    self->etwOutOfScope.fetch_add(1, std::memory_order_relaxed);
                    return;
                }
                outLen = known->size();
                std::memcpy(self->etwPathScratch, known->data(), outLen * sizeof(wchar_t));
                path = self->etwPathScratch;
                if (rw) {
                    byteOffset = ud_u64(ud, 0);
                    if (udLen >= 40) byteLen = ud_u32(ud, 36);
                }
                switch (opcode) {
                    case kOpClose:   kind = kKindClose; break;
                    case kOpRead:    kind = kKindRead; break;
                    case kOpWrite:   kind = kKindWrite; break;
                    case kOpSetInfo: kind = kKindSetInfo; break;
                    case kOpDelete:  kind = kKindDelete; break;
                    default:         kind = kKindRename; break;
                }
                if (opcode == kOpClose) self->etwObjPaths.erase(fileObject);
                break;
            }
            default:
                return;
        }
        self->etwAfterScope.fetch_add(1, std::memory_order_relaxed);
        self->etwAfterKind.fetch_add(1, std::memory_order_relaxed);

        // Real-time sessions started with ClientContext=1 stamp events
        // with raw QPC: the same clock domain as nowNs().
        LARGE_INTEGER freq{}, now{};
        QueryPerformanceFrequency(&freq);
        QueryPerformanceCounter(&now);
        std::uint64_t ts = qpc_to_ns(rec->EventHeader.TimeStamp, freq);
        const std::uint64_t nowNs = qpc_to_ns(now, freq);
        // An attached (not owned) session may use another clock type.
        if (ts > nowNs || nowNs - ts > 60ull * 1000000000ull) ts = nowNs;

        // Header in the public layout; the process name is added by drain().
        alignas(8) std::uint8_t slotBuf[HARIL_SLOT_SIZE];
        encode_event_slot(std::span<std::uint8_t, HARIL_SLOT_SIZE>(slotBuf),
            HARIL_SOURCE_ETW, kind, ts,
            rec->EventHeader.ProcessId,
            rec->EventHeader.ThreadId,
            irpPtr, 0, nullptr, 0,
            static_cast<std::uint32_t>(byteOffset), byteLen,
            shareAccess, createOpts, createDisp,
            static_cast<std::uint32_t>(self->etwEventsObserved.load(std::memory_order_relaxed)),
            std::wstring_view{});
        if (!self->etwRunning.load(std::memory_order_relaxed)) return;
        self->etwPushAttempted.fetch_add(1, std::memory_order_relaxed);
        if (!self->ring.push_record(slotBuf, path, outLen)) {
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
        etwTargetRoot = canonical_dir_path(root);
        procNameCache.clear();
        etwRootLower = lower_root_for_cmp(etwTargetRoot);
        etwRootAliasLower = lower_root_for_cmp(short_path_alias(etwTargetRoot));
        if (etwRootAliasLower == etwRootLower) etwRootAliasLower.clear();
        etwObjPaths.clear();
        etwKeyPaths.clear();
        etwLongDirCache.clear();
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
        // Larger, more numerous kernel buffers: FileIo is bursty and the
        // defaults drop thousands of events per second under load.
        p->BufferSize          = 1024;  // KB
        p->MinimumBuffers      = 64;
        p->MaximumBuffers      = 256;
        // FILE_IO_INIT: Create/Read/Write/... ; DISK_FILE_IO: FileKey names
        // (incl. rundown for already-open files); PROCESS for pid lifetime.
        p->EnableFlags         = EVENT_TRACE_FLAG_PROCESS | EVENT_TRACE_FLAG_DISK_FILE_IO
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

// Directories are not file lifecycles; only drop cached
                // names when they move so children resolve again.
                if (r->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
                    if (r->Reason & (USN_REASON_RENAME_OLD_NAME | USN_REASON_RENAME_NEW_NAME | USN_REASON_FILE_DELETE)) {
                        usnDirCache.clear();
                    }
                    p += r->RecordLength;
                    continue;
                }

                const std::uint64_t frn =
                    static_cast<std::uint64_t>(r->FileReferenceNumber);
                const std::uint64_t parentFrn =
                    static_cast<std::uint64_t>(r->ParentFileReferenceNumber);
                // Name as recorded (correct for deletes and old rename
                // names), under the parent's current path; fall back to
                // the file's own current path.
                std::wstring resolved;
                const std::wstring& parent = resolve_dir_path(parentFrn);
                if (!parent.empty()) {
                    const auto* name = reinterpret_cast<const wchar_t*>(
                        reinterpret_cast<const std::uint8_t*>(r) + r->FileNameOffset);
                    resolved = parent;
                    if (resolved.back() != L'\\') resolved.push_back(L'\\');
                    resolved.append(name, r->FileNameLength / sizeof(wchar_t));
                } else {
                    resolved = resolve_frn_path(frn);
                }
                if (resolved.empty()) {
                    // Neither the file nor its parent can be named: drop
                    // the record but count it so coverage stays honest.
                    usnDroppedUnresolved.fetch_add(1, std::memory_order_relaxed);
                    p += r->RecordLength;
                    continue;
                }
                if (!usnTargetRoot.empty() && !path_starts_with(resolved, usnTargetRoot)) {
                    p += r->RecordLength;
                    continue;
                }

                alignas(8) std::uint8_t slotBuf[HARIL_SLOT_SIZE];
                std::span<std::uint8_t, HARIL_SLOT_SIZE> slot(slotBuf);
                LARGE_INTEGER qpc{}, freq{};
                QueryPerformanceCounter(&qpc);
                QueryPerformanceFrequency(&freq);
                const std::uint64_t ts = qpc_to_ns(qpc, freq);

                // NTFS FILE_ID_128 is the 64-bit FRN zero-extended, the
                // same identity the inventory reads via FILE_ID_INFO.
                std::uint8_t fileId[16] = {0};
                std::memcpy(fileId, &frn, sizeof(frn));
                encode_event_slot(slot, HARIL_SOURCE_USN, kKindNotify, ts,
                                  0, 0, 0, 0, fileId, usnVolumeSerial,
                                  0, 0, 0, 0, 0,
                                  static_cast<std::uint32_t>(usnRecordsRead.load()),
                                  std::wstring_view{});
                encode_usn_extension(slot,
                    frn,
                    parentFrn,
                    static_cast<std::uint64_t>(r->Usn),
                    static_cast<std::uint32_t>(r->Reason));
                ring.push_record(slotBuf, resolved.data(), resolved.size());
                usnRecordsRead.fetch_add(1);

                p += r->RecordLength;
            }
            usnCursor = static_cast<std::uint64_t>(nextUsn);
            Sleep(20);
        }
    }

    // Resolve an FRN to its current DOS path (L"C:\\..."). Empty when
    // the file cannot be opened (deleted, transient).
    std::wstring resolve_frn_path(std::uint64_t frn) {
        FILE_ID_DESCRIPTOR fid{};
        fid.dwSize = sizeof(fid);
        fid.Type = FileIdType;
        fid.FileId.QuadPart = static_cast<LONGLONG>(frn);
        UniqueHandle h(make_unique(OpenFileById(
            usnVolumeHandle.get(), &fid,
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            nullptr, FILE_FLAG_BACKUP_SEMANTICS)));
        if (!h) return {};
        // GetFinalPathNameByHandleW always returns the \\?\ form; size the
        // buffer from the first call so long paths are not truncated.
        std::vector<wchar_t> out(512);
        DWORD len = GetFinalPathNameByHandleW(h.get(), out.data(),
                                              static_cast<DWORD>(out.size()),
                                              VOLUME_NAME_DOS);
        if (len >= out.size()) {
            out.resize(static_cast<std::size_t>(len) + 1);
            len = GetFinalPathNameByHandleW(h.get(), out.data(),
                                            static_cast<DWORD>(out.size()),
                                            VOLUME_NAME_DOS);
        }
        if (len == 0 || len >= out.size()) return {};
        return strip_long_prefix(std::wstring_view(out.data(), len));
    }

    // Cached directory FRN -> path (empty string when unresolvable).
    const std::wstring& resolve_dir_path(std::uint64_t frn) {
        auto it = usnDirCache.find(frn);
        if (it != usnDirCache.end()) return it->second;
        if (usnDirCache.size() > 65536) usnDirCache.clear();
        return usnDirCache.emplace(frn, resolve_frn_path(frn)).first->second;
    }
    int32_t usn_start(std::wstring_view volume, std::wstring_view root) {
        if (usnRunning) return -1;
        usnVolume.assign(volume.begin(), volume.end());
        usnTargetRoot = canonical_dir_path(root);
        usnDirCache.clear();
        usnVolumeSerial = 0;
        {
            // Same volume serial the inventory reads via FILE_ID_INFO, so
            // USN identities match inventory identities.
            const UniqueHandle hr(make_unique(CreateFileW(
                to_long_path(usnTargetRoot).c_str(), 0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr)));
            FILE_ID_INFO id{};
            if (hr && GetFileInformationByHandleEx(hr.get(), FileIdInfo, &id, sizeof(id))) {
                usnVolumeSerial = static_cast<std::uint32_t>(id.VolumeSerialNumber);
            }
        }
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

    // Base name of a process image, cached per pid. pid 0/4 are kernel.
    const std::wstring& process_name(std::uint32_t pid) {
        auto it = procNameCache.find(pid);
        if (it != procNameCache.end()) return it->second;
        std::wstring name;
        if (pid == 0) {
            name = L"Idle";
        } else if (pid == 4) {
            name = L"System";
        } else {
            const UniqueHandle h(make_unique(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid)));
            if (h) {
                std::vector<wchar_t> buf(1024);
                DWORD len = static_cast<DWORD>(buf.size());
                if (QueryFullProcessImageNameW(h.get(), 0, buf.data(), &len) && len > 0) {
                    std::wstring_view full(buf.data(), len);
                    const auto slash = full.find_last_of(L"\\/");
                    name.assign(slash == std::wstring_view::npos ? full : full.substr(slash + 1));
                }
            }
        }
        if (procNameCache.size() > 8192) procNameCache.clear();
        return procNameCache.emplace(pid, std::move(name)).first->second;
    }

    int32_t drain(std::uint8_t* out_buf, std::int32_t max_slots,
                   std::uint64_t* out_seq) {
        std::uint64_t seq = 0;
        const int n = ring.pop_batch(
            std::span<std::uint8_t>(out_buf, static_cast<std::size_t>(max_slots) * HARIL_SLOT_SIZE),
            &seq);
        // Walk record heads (skipping continuation slots) and add the
        // process image name to ETW records.
        for (int i = 0; i < n;) {
            std::uint8_t* slot = out_buf + static_cast<std::size_t>(i) * HARIL_SLOT_SIZE;
            const std::uint16_t source = *reinterpret_cast<std::uint16_t*>(slot);
            const std::uint16_t extra = *reinterpret_cast<std::uint16_t*>(slot + 80);
            if (source == HARIL_SOURCE_ETW) {
                const std::uint32_t pid = *reinterpret_cast<std::uint32_t*>(slot + 12);
                const std::wstring& name = process_name(pid);
                put_slot_string(slot, HARIL_SLOT_PROC_OFFSET, HARIL_SLOT_PROC_CHARS, 78,
                                name.data(), name.size());
            }
            i += 1 + extra;
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
        to_long_path(path).c_str(), 0,
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
