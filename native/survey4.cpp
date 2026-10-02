// Survey v4: dump FULL blobs for selected opcodes during controlled ops.
#include <windows.h>
#include <evntrace.h>
#include <evntcons.h>
#include <tdh.h>
#include <cstdio>
#include <vector>
#include <string>
#include <unordered_set>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "tdh.lib")

static volatile bool g_stop = false;
static std::unordered_set<unsigned> g_want;
static unsigned g_pidFilter = 0;
static int g_budget = 2000;

static VOID WINAPI OnEvent(PEVENT_RECORD rec) {
    if (g_stop || g_budget <= 0) return;
    auto& h = rec->EventHeader;
    if (g_pidFilter && h.ProcessId != g_pidFilter) return;
    if (h.ProviderId.Data1 != 0x90cbdc39) return;
    unsigned op = h.EventDescriptor.Opcode;
    if (!g_want.empty() && !g_want.count(op)) return;
    g_budget--;
    const uint8_t* b = (const uint8_t*)rec->UserData;
    int len = (int)rec->UserDataLength;
    printf("=== op=%u ver=%u pid=%u tid=%u len=%d\n", op,
        h.EventDescriptor.Version, h.ProcessId, h.ThreadId, len);
    for (int i = 0; i < len; i += 16) {
        printf("  %04x:", i);
        for (int j = 0; j < 16 && i + j < len; j++) printf(" %02x", b[i + j]);
        printf("  |");
        for (int j = 0; j < 16 && i + j < len; j++) {
            uint16_t c = 0;
            if (i + j + 1 < len) c = (uint16_t)b[i + j] | ((uint16_t)b[i + j + 1] << 8);
            putwchar((c >= 32 && c < 127) ? (wchar_t)c : L'.');
            j++;
        }
        printf("|\n");
    }
}
static ULONG WINAPI OnBuffer(PEVENT_TRACE_LOGFILEW) { return TRUE; }

int wmain(int argc, wchar_t** argv) {
    // usage: survey4 [--pid N] [op...]
    int ai = 1;
    if (ai < argc && wcscmp(argv[ai], L"--pid") == 0 && ai + 1 < argc) {
        g_pidFilter = (unsigned)_wtoi(argv[ai + 1]);
        ai += 2;
    }
    for (int i = ai; i < argc; i++) g_want.insert((unsigned)_wtoi(argv[i]));
    EVENT_TRACE_LOGFILEW log{};
    log.LoggerName = const_cast<LPWSTR>(L"NT Kernel Logger");
    log.ProcessTraceMode = PROCESS_TRACE_MODE_EVENT_RECORD | PROCESS_TRACE_MODE_REAL_TIME;
    log.EventRecordCallback = OnEvent;
    log.BufferCallback = OnBuffer;
    TRACEHANDLE h = OpenTraceW(&log);
    if (h == INVALID_PROCESSTRACE_HANDLE) { printf("OpenTrace %lu\n", GetLastError()); return 1; }
    printf("dumping 20s...\n");
    HANDLE th = CreateThread(nullptr, 0, [](void* p) -> DWORD {
        ProcessTrace((TRACEHANDLE*)p, 1, nullptr, nullptr); return 0;
    }, &h, 0, nullptr);
    Sleep(20000);
    g_stop = true;
    CloseTrace(h);
    WaitForSingleObject(th, 5000);
    printf("done\n");
    return 0;
}
