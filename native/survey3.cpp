// Survey v3: churn known filenames, then search each event blob for
// their UTF-16 bytes. Reports (provider, opcode, offset-of-match,
// blobLen) — the empirical field layout for path-carrying events.
#include <windows.h>
#include <evntrace.h>
#include <evntcons.h>
#include <tdh.h>
#include <cstdio>
#include <vector>
#include <string>
#include <unordered_map>
#include <unordered_set>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "tdh.lib")

static volatile bool g_stop = false;
static std::vector<std::wstring> g_needles;
static std::unordered_set<unsigned long long> g_seenLayout;

static void checkBlob(PEVENT_RECORD rec) {
    auto& h = rec->EventHeader;
    const uint8_t* blob = (const uint8_t*)rec->UserData;
    int len = (int)rec->UserDataLength;
    for (auto& needle : g_needles) {
        int nl = (int)needle.size();
        if (nl == 0) continue;
        for (int off = 0; off + nl * 2 <= len; off++) {
            bool ok = true;
            for (int i = 0; i < nl; i++) {
                uint16_t c = (uint16_t)blob[off + i * 2] | ((uint16_t)blob[off + i * 2 + 1] << 8);
                if (c != (uint16_t)needle[i]) { ok = false; break; }
            }
            if (!ok) continue;
            unsigned long long key = ((unsigned long long)h.EventDescriptor.Opcode << 32) |
                h.ProviderId.Data1;
            if (!g_seenLayout.insert(key).second) return;
            bool is32 = (h.Flags & EVENT_HEADER_FLAG_32_BIT_HEADER) != 0;
            printf("MATCH prov=%08x op=%u ver=%u blobLen=%d off=%d ptrsize=%s\n",
                h.ProviderId.Data1, h.EventDescriptor.Opcode,
                h.EventDescriptor.Version, len, off, is32 ? "32" : "64");
            printf("  hex[0..64]:");
            for (int i = 0; i < 64 && i < len; i++) printf(" %02x", blob[i]);
            printf("\n  needle='%ls'\n", needle.c_str());
            return;
        }
    }
}

static VOID WINAPI OnEvent(PEVENT_RECORD rec) {
    if (!g_stop) checkBlob(rec);
}
static ULONG WINAPI OnBuffer(PEVENT_TRACE_LOGFILEW) { return TRUE; }

int wmain(int argc, wchar_t** argv) {
    for (int i = 1; i < argc; i++) g_needles.push_back(argv[i]);
    EVENT_TRACE_LOGFILEW log{};
    log.LoggerName = const_cast<LPWSTR>(L"NT Kernel Logger");
    log.ProcessTraceMode = PROCESS_TRACE_MODE_EVENT_RECORD | PROCESS_TRACE_MODE_REAL_TIME;
    log.EventRecordCallback = OnEvent;
    log.BufferCallback = OnBuffer;
    TRACEHANDLE h = OpenTraceW(&log);
    if (h == INVALID_PROCESSTRACE_HANDLE) { printf("OpenTrace %lu\n", GetLastError()); return 1; }
    printf("listening 12s for %d needles...\n", (int)g_needles.size());
    HANDLE th = CreateThread(nullptr, 0, [](void* p) -> DWORD {
        ProcessTrace((TRACEHANDLE*)p, 1, nullptr, nullptr); return 0;
    }, &h, 0, nullptr);
    Sleep(12000);
    g_stop = true;
    CloseTrace(h);
    WaitForSingleObject(th, 5000);
    printf("done\n");
    return 0;
}
