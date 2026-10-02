/*
 * haril_native.h — public API for haril_native.node / haril_native.dll.
 *
 * Loaded either as:
 *   - A plain Windows DLL via bun:ffi, koffi, or LoadLibraryW.
 *   - A Node-API addon via `require("haril-napi")` (recommended on Bun).
 *
 * Strings are UTF-16LE with explicit length because neither bun:ffi nor
 * Node-API auto-converts UTF-8 to UTF-16LE. The `napi_addon.cpp` wrapper
 * converts JS strings to UTF-16LE on the way in.
 *
 * Capture happens via a producer/consumer ring buffer: ETW and USN
 * producer threads push 256-byte slots; the JS consumer calls
 * `haril_drain` to pop a batch.
 */

#ifndef HARIL_NATIVE_H
#define HARIL_NATIVE_H

#include <stdint.h>

#if defined(_WIN32)
#  define HARIL_EXPORT __declspec(dllexport)
#else
#  define HARIL_EXPORT __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef struct HarilContext HarilContext;

typedef enum {
    HARIL_SOURCE_ETW = 1,
    HARIL_SOURCE_USN = 2,
    HARIL_SOURCE_FSW = 3,
} HarilSource;

HARIL_EXPORT HarilContext* haril_open(void);
HARIL_EXPORT void         haril_close(HarilContext* ctx);

HARIL_EXPORT int32_t haril_source_status(HarilContext* ctx, HarilSource src);

HARIL_EXPORT int32_t haril_etw_start(HarilContext* ctx,
                                     const uint16_t* session_utf16, int32_t session_len,
                                     const uint16_t* root_utf16, int32_t root_len);
HARIL_EXPORT int32_t haril_etw_stop(HarilContext* ctx);
HARIL_EXPORT uint64_t haril_etw_events_lost(HarilContext* ctx);
HARIL_EXPORT uint64_t haril_etw_buffers_written(HarilContext* ctx);
HARIL_EXPORT uint64_t haril_etw_events_observed(HarilContext* ctx);
HARIL_EXPORT uint64_t haril_etw_candidates_out_of_scope(HarilContext* ctx);
HARIL_EXPORT uint64_t haril_etw_candidates_without_path(HarilContext* ctx);
HARIL_EXPORT uint64_t haril_etw_ring_push_failed(HarilContext* ctx);
HARIL_EXPORT uint64_t haril_etw_push_attempted(HarilContext* ctx);
HARIL_EXPORT uint64_t haril_etw_kind_zero(HarilContext* ctx);
HARIL_EXPORT uint64_t haril_etw_after_kind(HarilContext* ctx);
HARIL_EXPORT uint64_t haril_etw_after_scope(HarilContext* ctx);
HARIL_EXPORT uint64_t haril_ring_head(HarilContext* ctx);
HARIL_EXPORT uint64_t haril_ring_tail(HarilContext* ctx);
HARIL_EXPORT uint64_t haril_usn_dropped_unresolved(HarilContext* ctx);

HARIL_EXPORT int32_t haril_usn_start(HarilContext* ctx,
                                     const uint16_t* volume_utf16, int32_t volume_len,
                                     const uint16_t* root_utf16, int32_t root_len);
HARIL_EXPORT int32_t haril_usn_stop(HarilContext* ctx);
HARIL_EXPORT uint64_t haril_usn_records_read(HarilContext* ctx);

HARIL_EXPORT int32_t haril_inventory_walk(HarilContext* ctx,
                                         const uint16_t* root_utf16, int32_t root_len,
                                         int is_initial,
                                         int (*emit_cb)(const uint8_t* record, int32_t record_len, void* user),
                                         void* user);

HARIL_EXPORT int32_t haril_get_file_id(const uint16_t* path_utf16, int32_t path_len,
                                       uint8_t* out_id16,
                                       uint32_t* out_volume_serial);

HARIL_EXPORT int32_t haril_is_admin(void);
HARIL_EXPORT int32_t haril_relaunch_elevated(const uint16_t* exe_utf16, int32_t exe_len,
                                              const uint16_t* args_utf16, int32_t args_len);

#define HARIL_SLOT_SIZE 256
HARIL_EXPORT int32_t haril_drain(HarilContext* ctx,
                                 uint8_t* out_buf,
                                 int32_t max_slots,
                                 uint64_t* out_seq_high);

#ifdef __cplusplus
}
#endif

#endif /* HARIL_NATIVE_H */