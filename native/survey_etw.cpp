// ETW mix survey: attach to NT Kernel Logger for N seconds, count by
// (provider, eventId): total, with-path (first UNICODESTRING formats
// non-empty), without-path. No filtering, no StartTrace (attach only).
#include <windows.h>
#include <evntrace.h>
#include <evntcons.h>
#include <tdh.h>
#include <cstdio>
#include <unordered_set>
#include <vector>
#include <string>
#include <unordered_map>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "tdh.lib")

static std::unordered_map<unsigned long long, unsigned long long> g_total;
static std::unordered_map<unsigned long long, unsigned long long> g_withPath;
static std::unordered_map<unsigned long long, unsigned> g_opcode;
static std::unordered_map<unsigned long long, unsigned> g_idver;
static std::unordered_map<unsigned long long, std::wstring> g_evname;
static std::unordered_set<unsigned long long> g_seen;
static volatile bool g_stop = false;

static std::wstring fmtProp(PTRACE_EVENT_INFO info, ULONG idx, PEVENT_RECORD rec) {
    auto* prop = &info->EventPropertyInfoArray[idx];
    if (prop->Flags & PropertyStruct) return {};
    USHORT ps = (rec->EventHeader.Flags & EVENT_HEADER_FLAG_32_BIT_HEADER) ? 4 : 8;
    ULONG need = 0; USHORT consumed = 0;
    USHORT propLen = prop->length;
    TdhFormatProperty(info, nullptr, (ULONG)ps,
        prop->nonStructType.InType, prop->nonStructType.OutType, propLen,
        (USHORT)rec->UserDataLength, (PBYTE)rec->UserData,
        &need, nullptr, &consumed);
    if (!need) return {};
    std::wstring out(need, L'\0');
    if (TdhFormatProperty(info, nullptr, (ULONG)ps,
        prop->nonStructType.InType, prop->nonStructType.OutType, propLen,
        (USHORT)rec->UserDataLength, (PBYTE)rec->UserData,
        &need, out.data(), &consumed) != ERROR_SUCCESS) return {};
    while (!out.empty() && out.back() == L'\0') out.pop_back();
    return out;
}

static VOID WINAPI OnEvent(PEVENT_RECORD rec) {
    if (g_stop) return;
    auto& h = rec->EventHeader;
    unsigned long long key = ((unsigned long long)h.EventDescriptor.Id << 48) |
        ((unsigned long long)h.EventDescriptor.Version << 40) |
        ((unsigned long long)h.EventDescriptor.Opcode << 32) |
        h.ProviderId.Data1;
    g_total[key]++;
    g_opcode[key] = h.EventDescriptor.Opcode;
    g_idver[key] = ((unsigned)h.EventDescriptor.Id << 8) | h.EventDescriptor.Version;
    // schema (note: Opcode matters for MOF events — Id is 0 there).
    // Try the REAL record first; the synthetic record is only a fallback.
    ULONG size = 0;
    TDHSTATUS s0 = TdhGetEventInformation(rec, 0, nullptr, nullptr, &size);
    EVENT_DESCRIPTOR desc = { 0 };
    desc.Id = rec->EventHeader.EventDescriptor.Id;
    desc.Version = rec->EventHeader.EventDescriptor.Version;
    desc.Opcode = rec->EventHeader.EventDescriptor.Opcode;
    EVENT_RECORD tmp{}; tmp.EventHeader.ProviderId = rec->EventHeader.ProviderId;
    tmp.EventHeader.EventDescriptor = desc;
    if (size == 0) {
        TdhGetEventInformation(&tmp, 0, nullptr, nullptr, &size);
    }
    if (!size) {
        if (g_seen.insert(key | 0x4000000000000000ULL).second)
            printf("  schema NONE op=%u s0=%u\n", rec->EventHeader.EventDescriptor.Opcode, s0);
        return;
    }
    std::vector<uint8_t> buf(size);
    TDHSTATUS s2 = TdhGetEventInformation(&tmp, 0, nullptr, (PTRACE_EVENT_INFO)buf.data(), &size);
    if (s2) {
        if (g_seen.insert(key | 0x4000000000000000ULL).second)
            printf("  schema FAIL op=%u rc=%u\n", rec->EventHeader.EventDescriptor.Opcode, s2);
        return;
    }
    auto* info = (PTRACE_EVENT_INFO)buf.data();
    if (g_seen.insert(key).second) {
        wprintf(L"  schema op=%u: props=%u top=%u decoding=%u flags=0x%x\n",
            rec->EventHeader.EventDescriptor.Opcode,
            info->PropertyCount, info->TopLevelPropertyCount,
            (unsigned)info->DecodingSource, (unsigned)info->Flags);
        for (ULONG i = 0; i < info->TopLevelPropertyCount && i < 12; i++) {
            auto* e = &info->EventPropertyInfoArray[i];
            wprintf(L"    [%u] in=%u out=%u flags=0x%x count=%u\n", i,
                (unsigned)e->nonStructType.InType,
                (unsigned)e->nonStructType.OutType,
                (unsigned)e->Flags, (unsigned)e->count);
        }
    }
    const wchar_t* evName = L"?";
    if (info->EventNameOffset) evName = (const wchar_t*)(buf.data() + info->EventNameOffset);
    if (g_evname.find(key) == g_evname.end()) g_evname[key] = evName;
    for (ULONG i = 0; i < info->TopLevelPropertyCount; i++) {
        if (info->EventPropertyInfoArray[i].Flags & PropertyStruct) continue;
        if ((unsigned)info->EventPropertyInfoArray[i].nonStructType.InType != TDH_INTYPE_UNICODESTRING) continue;
        if (!fmtProp(info, i, rec).empty()) {
            g_withPath[key]++;
            if (g_withPath[key] == 1) {
                wprintf(L"    e.g. op=%u name=%ls\n",
                    rec->EventHeader.EventDescriptor.Opcode, evName);
            }
            return;
        }
    }
}

static ULONG WINAPI OnBuffer(PEVENT_TRACE_LOGFILEW) { return TRUE; }

int wmain(int argc, wchar_t** argv) {
    int secs = argc > 1 ? _wtoi(argv[1]) : 5;
    EVENT_TRACE_LOGFILEW log{};
    log.LoggerName = const_cast<LPWSTR>(L"NT Kernel Logger");
    log.ProcessTraceMode = PROCESS_TRACE_MODE_EVENT_RECORD | PROCESS_TRACE_MODE_REAL_TIME;
    log.EventRecordCallback = OnEvent;
    log.BufferCallback = OnBuffer;
    TRACEHANDLE h = OpenTraceW(&log);
    if (h == INVALID_PROCESSTRACE_HANDLE) { printf("OpenTrace failed %lu\n", GetLastError()); return 1; }
    HANDLE th = CreateThread(nullptr, 0, [](void* p) -> DWORD {
        ProcessTrace((TRACEHANDLE*)p, 1, nullptr, nullptr); return 0;
    }, &h, 0, nullptr);
    Sleep(secs * 1000);
    g_stop = true;
    CloseTrace(h);
    WaitForSingleObject(th, 5000);
    printf("provider-data1 opcode id:ver name : total withPath\n");
    for (auto& [k, v] : g_total) {
        auto it = g_withPath.find(k);
        auto nit = g_evname.find(k);
        wprintf(L"  %08x op=%3u id:%u ver:%u %-18ls : %7llu %7llu\n",
            (unsigned)(k & 0xFFFFFFFF), g_opcode[k],
            g_idver[k] >> 8, g_idver[k] & 0xFF,
            nit == g_evname.end() ? L"?" : nit->second.c_str(),
            v, it == g_withPath.end() ? 0 : it->second);
    }
    return 0;
}
