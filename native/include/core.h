/*
 * core.h — internal C++ class declaration for HarilContext.
 *
 * IMPORTANT: this header does NOT include haril_native.h (the public
 * C ABI). haril_native.h opens an `extern "C"` block, which would
 * prevent us from declaring C++ methods inside this class.
 *
 * Source files that need both HarilContext and the C ABI (core.cpp,
 * napi_addon.cpp, the smoke test) include both. Source files that
 * only need the C++ API include just this one.
 *
 * The Windows types used here (GUID) are forward-declared in this
 * header but defined by <windows.h> when core.cpp is compiled. The
 * Node-API addon never sees <windows.h>.
 */

#ifndef HARIL_CORE_H
#define HARIL_CORE_H

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <span>
#include <string>
#include <string_view>
#include <vector>

// Forward-declare GUID as the bare Win32 type. core.cpp will see the
// full definition via <windows.h>; napi_addon.cpp never sees <windows.h>
// and so uses only this opaque forward declaration.
struct _GUID;
typedef struct _GUID GUID;

// Rich inventory row including the full path, for the synchronous
// N-API inventoryWalk export. fileId128 is valid only when hasFileId.
struct InventoryRow {
    std::wstring  path;
    std::uint64_t lastWriteTime = 0;
    std::uint64_t creationTime = 0;
    std::uint32_t length = 0;
    std::uint32_t attributes = 0;
    std::uint8_t  fileId128[16] = {0};
    std::uint32_t volumeSerial = 0;
    bool          hasFileId = false;
};

struct HarilContext {
public:
    HarilContext();
    ~HarilContext();

    HarilContext(const HarilContext&) = delete;
    HarilContext& operator=(const HarilContext&) = delete;

    // Lifecycle methods. Defined in core.cpp.
    int32_t etw_start(std::wstring_view session, std::wstring_view root);
    int32_t etw_stop();
    int32_t usn_start(std::wstring_view volume, std::wstring_view root);
    int32_t usn_stop();
    int32_t inventory_walk(std::wstring_view root, int is_initial,
                            int (*emit_cb)(const std::uint8_t*, std::int32_t, void*),
                            void* user);
    int32_t drain(std::uint8_t* out_buf, std::int32_t max_slots, std::uint64_t* out_seq);

    // Synchronous directory walk returning rows with full paths and
    // FILE_ID_INFO identity when readable. Used by the N-API
    // inventoryWalk export. Defined in core.cpp.
    std::vector<InventoryRow> walk_inventory(std::wstring_view root);

    // Accessors. Defined in core.cpp because they read Impl's atomics.
    bool    is_etw_running() const noexcept;
    bool    is_usn_running() const noexcept;
    std::uint64_t etw_events_lost() const noexcept;
    std::uint64_t etw_buffers_written() const noexcept;
    std::uint64_t etw_events_observed() const noexcept;
    std::uint64_t etw_candidates_out_of_scope() const noexcept;
    std::uint64_t etw_candidates_without_path() const noexcept;
    std::uint64_t etw_ring_push_failed() const noexcept;
    std::uint64_t etw_push_attempted() const noexcept;
    std::uint64_t etw_kind_zero() const noexcept;
    std::uint64_t etw_after_kind() const noexcept;
    std::uint64_t etw_after_scope() const noexcept;
    std::uint64_t ring_head() const noexcept;
    std::uint64_t ring_tail() const noexcept;
    std::uint64_t usn_dropped_unresolved() const noexcept;
    std::uint64_t usn_records_read() const noexcept;

    // Hash a GUID. Defined in core.cpp because it depends on the layout
    // of struct _GUID, which we forward-declare here.
    static std::uint64_t hash_guid(const GUID& g) noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

#endif /* HARIL_CORE_H */