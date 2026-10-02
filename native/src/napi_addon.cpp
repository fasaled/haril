// napi_addon.cpp — Node-API wrapper for the haril-native C++ core.
//
// We deliberately keep this file thin: it converts JS values to the C++
// forms the `HarilContext` API expects, then forwards. All Windows-specific
// logic lives in core.cpp. This keeps the JS-visible ABI surface small
// and free of Windows headers.
//
// Output: haril_native.node (Node addon). Node-API version is fixed at 8
// (matching node-addon-api 8.x and Node 20+).

#include <node_api.h>

#include <windows.h>

#include <cstring>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "core.h"
#include "haril_native.h"

namespace {

// ----------------------- JS string -> std::wstring (UTF-16LE) -----------------------

std::wstring utf16_from_napi(napi_env env, napi_value value) {
    if (value == nullptr) return {};
    napi_valuetype t = napi_undefined;
    napi_typeof(env, value, &t);
    if (t == napi_undefined || t == napi_null) return {};

    std::size_t len = 0;
    napi_get_value_string_utf16(env, value, nullptr, 0, &len);
    if (len == 0) return {};

    std::vector<char16_t> buf(len + 1, 0);
    napi_get_value_string_utf16(env, value,
                                 reinterpret_cast<char16_t*>(buf.data()),
                                 buf.size(), nullptr);
    return std::wstring(reinterpret_cast<const wchar_t*>(buf.data()), len);
}

// Helper: calls napi_throw_error and returns nullptr so callers can
// `return throw_js(env, msg);` directly.
napi_value throw_js(napi_env env, const char* message) {
    napi_throw_error(env, nullptr, message);
    return nullptr;
}

// ----------------------- HarilContext wrapper -----------------------

void finalizer_haril_context(napi_env /*env*/, void* native_ptr, void* /*hint*/) {
    delete static_cast<HarilContext*>(native_ptr);
}

napi_value wrap_context(napi_env env, HarilContext* ctx) {
    napi_value obj = nullptr;
    napi_create_object(env, &obj);
    if (!obj) return nullptr;
    const napi_status s = napi_wrap(env, obj, ctx, finalizer_haril_context,
                                     nullptr, nullptr);
    if (s != napi_ok) {
        napi_throw_error(env, nullptr, "napi_wrap failed");
        return nullptr;
    }
    return obj;
}

HarilContext* unwrap_context(napi_env env, napi_value obj) {
    HarilContext* ctx = nullptr;
    if (napi_unwrap(env, obj, reinterpret_cast<void**>(&ctx)) != napi_ok) {
        return nullptr;
    }
    return ctx;
}

// ----------------------- Export functions -----------------------

napi_value open_session(napi_env env, napi_callback_info /*info*/) {
    HarilContext* ctx = nullptr;
    try {
            ctx = new HarilContext();
    } catch (const std::exception& e) {
        return throw_js(env, e.what());
    } catch (...) {
        return throw_js(env, "HarilContext allocation failed");
    }
    if (!ctx) return throw_js(env, "haril_open returned null");

    napi_value obj = wrap_context(env, ctx);
    if (!obj) {
        delete ctx;
        return throw_js(env, "wrap_context failed");
    }
    return obj;
}

napi_value close_session(napi_env env, napi_callback_info info) {
    std::size_t argc = 1;
    napi_value argv[1];
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) {
        return throw_js(env, "closeSession requires 1 arg");
    }
    HarilContext* ctx = unwrap_context(env, argv[0]);
    if (ctx) {
        ctx->etw_stop();
        ctx->usn_stop();
    }
    napi_remove_wrap(env, argv[0], nullptr);
    delete ctx;
    return nullptr;
}

napi_value source_status_js(napi_env env, napi_callback_info info) {
    std::size_t argc = 2;
    napi_value argv[2];
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 2) {
        return throw_js(env, "sourceStatus(ctx, source)");
    }
    HarilContext* ctx = unwrap_context(env, argv[0]);
    if (!ctx) return throw_js(env, "invalid context");

    int32_t source = 0;
    napi_get_value_int32(env, argv[1], &source);
    const int32_t r = haril_source_status(ctx, static_cast<HarilSource>(source));

    napi_value out = nullptr;
    napi_create_int32(env, r, &out);
    return out;
}

napi_value etw_start_js(napi_env env, napi_callback_info info) {
    std::size_t argc = 3;
    napi_value argv[3];
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 3) {
        return throw_js(env, "etwStart(ctx, session, root)");
    }
    HarilContext* ctx = unwrap_context(env, argv[0]);
    if (!ctx) return throw_js(env, "invalid context");

    const auto session = utf16_from_napi(env, argv[1]);
    const auto root    = utf16_from_napi(env, argv[2]);
    const int32_t r = haril_etw_start(ctx,
        reinterpret_cast<const std::uint16_t*>(session.data()),
        static_cast<std::int32_t>(session.size()),
        reinterpret_cast<const std::uint16_t*>(root.data()),
        static_cast<std::int32_t>(root.size()));

    napi_value out = nullptr;
    napi_create_int32(env, r, &out);
    return out;
}

napi_value etw_stop_js(napi_env env, napi_callback_info info) {
    std::size_t argc = 1;
    napi_value argv[1];
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) {
        return throw_js(env, "etwStop(ctx)");
    }
    HarilContext* ctx = unwrap_context(env, argv[0]);
    if (!ctx) return throw_js(env, "invalid context");
    napi_value out = nullptr;
    napi_create_int32(env, haril_etw_stop(ctx), &out);
    return out;
}

template <auto Getter>
napi_value atomic_counter_js(napi_env env, napi_callback_info info) {
    std::size_t argc = 1;
    napi_value argv[1];
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) {
        return throw_js(env, "missing context argument");
    }
    HarilContext* ctx = unwrap_context(env, argv[0]);
    if (!ctx) return throw_js(env, "invalid context");
    const std::uint64_t v = (ctx->*Getter)();
    napi_value out = nullptr;
    napi_create_bigint_uint64(env, v, &out);
    return out;
}

napi_value usn_start_js(napi_env env, napi_callback_info info) {
    std::size_t argc = 3;
    napi_value argv[3];
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 3) {
        return throw_js(env, "usnStart(ctx, volume, root)");
    }
    HarilContext* ctx = unwrap_context(env, argv[0]);
    if (!ctx) return throw_js(env, "invalid context");
    const auto volume = utf16_from_napi(env, argv[1]);
    const auto root = utf16_from_napi(env, argv[2]);
    const int32_t r = haril_usn_start(ctx,
        reinterpret_cast<const std::uint16_t*>(volume.data()),
        static_cast<std::int32_t>(volume.size()),
        reinterpret_cast<const std::uint16_t*>(root.data()),
        static_cast<std::int32_t>(root.size()));
    napi_value out = nullptr;
    napi_create_int32(env, r, &out);
    return out;
}

napi_value usn_stop_js(napi_env env, napi_callback_info info) {
    std::size_t argc = 1;
    napi_value argv[1];
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) {
        return throw_js(env, "usnStop(ctx)");
    }
    HarilContext* ctx = unwrap_context(env, argv[0]);
    if (!ctx) return throw_js(env, "invalid context");
    napi_value out = nullptr;
    napi_create_int32(env, haril_usn_stop(ctx), &out);
    return out;
}

napi_value drain_js(napi_env env, napi_callback_info info) {
    std::size_t argc = 2;
    napi_value argv[2];
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 2) {
        return throw_js(env, "drain(ctx, maxSlots)");
    }
    HarilContext* ctx = unwrap_context(env, argv[0]);
    if (!ctx) return throw_js(env, "invalid context");

    int32_t maxSlots = 1024;
    napi_get_value_int32(env, argv[1], &maxSlots);
    if (maxSlots <= 0) maxSlots = 1;

    const std::size_t out_bytes = static_cast<std::size_t>(maxSlots) * HARIL_SLOT_SIZE;
    std::vector<std::uint8_t> tmp(out_bytes);
    std::uint64_t seq = 0;
    const int32_t n = haril_drain(ctx, tmp.data(), maxSlots, &seq);
    const int32_t clamped = (n < 0) ? 0 : (n > maxSlots ? maxSlots : n);

    napi_value out = nullptr;
    void* data = nullptr;
    if (napi_create_arraybuffer(env,
                                 static_cast<std::size_t>(clamped) * HARIL_SLOT_SIZE,
                                 &data, &out) != napi_ok) {
        return throw_js(env, "create_arraybuffer failed");
    }
    if (data && clamped > 0) {
        std::memcpy(data, tmp.data(),
                    static_cast<std::size_t>(clamped) * HARIL_SLOT_SIZE);
    }
    return out;
}

napi_value is_admin_js(napi_env env, napi_callback_info /*info*/) {
    napi_value out = nullptr;
    napi_create_int32(env, haril_is_admin(), &out);
    return out;
}

// nowNs(): current QPC timestamp in nanoseconds. This is the single
// clock domain for capture: event slots, inventory observedAt, FSW
// notification timestamps and the manifest window all use it, so the
// package timeline is self-consistent.
napi_value now_ns_js(napi_env env, napi_callback_info /*info*/) {
    LARGE_INTEGER qpc{}, freq{};
    QueryPerformanceCounter(&qpc);
    QueryPerformanceFrequency(&freq);
    std::uint64_t ns = 0;
    if (freq.QuadPart != 0) {
        ns = static_cast<std::uint64_t>(
            (qpc.QuadPart * 1000000000ULL) / static_cast<std::uint64_t>(freq.QuadPart));
    }
    napi_value out = nullptr;
    napi_create_bigint_uint64(env, ns, &out);
    return out;
}

// fsKind(root): filesystem type name (e.g. "NTFS") or null on failure.
// Used for the NTFS-only capture pre-flight (DEC-040).
napi_value fs_kind_js(napi_env env, napi_callback_info info) {
    std::size_t argc = 1;
    napi_value argv[1];
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) {
        return throw_js(env, "fsKind(root)");
    }
    const auto root = utf16_from_napi(env, argv[0]);
    if (root.empty()) return throw_js(env, "fsKind requires a non-empty root");

    // Resolve the containing volume root first: GetVolumeInformationW
    // wants the volume's root path, not an arbitrary subdirectory.
    wchar_t volumeRoot[MAX_PATH] = {0};
    if (!GetVolumePathNameW(root.c_str(), volumeRoot, MAX_PATH)) {
        napi_value nullv = nullptr;
        napi_get_null(env, &nullv);
        return nullv;
    }
    wchar_t fsName[MAX_PATH] = {0};
    if (!GetVolumeInformationW(volumeRoot, nullptr, 0, nullptr, nullptr,
                               nullptr, fsName, MAX_PATH)) {
        napi_value nullv = nullptr;
        napi_get_null(env, &nullv);
        return nullv;
    }
    napi_value out = nullptr;
    napi_create_string_utf16(env,
        reinterpret_cast<const char16_t*>(fsName),
        wcslen(fsName), &out);
    return out;
}

napi_value relaunch_elevated_js(napi_env env, napi_callback_info info) {
    std::size_t argc = 2;
    napi_value argv[2];
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 2) {
        return throw_js(env, "relaunchElevated(exe, args)");
    }
    const auto exe  = utf16_from_napi(env, argv[0]);
    const auto args = utf16_from_napi(env, argv[1]);
    const int32_t r = haril_relaunch_elevated(
        reinterpret_cast<const std::uint16_t*>(exe.data()),
        static_cast<std::int32_t>(exe.size()),
        reinterpret_cast<const std::uint16_t*>(args.data()),
        static_cast<std::int32_t>(args.size()));
    napi_value out = nullptr;
    napi_create_int32(env, r, &out);
    return out;
}

napi_value get_file_id_js(napi_env env, napi_callback_info info) {
    std::size_t argc = 1;
    napi_value argv[1];
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) {
        return throw_js(env, "getFileId(path)");
    }
    const auto path = utf16_from_napi(env, argv[0]);
    std::uint8_t id[16] = {0};
    std::uint32_t vsn = 0;
    const int32_t rc = haril_get_file_id(
        reinterpret_cast<const std::uint16_t*>(path.data()),
        static_cast<std::int32_t>(path.size()),
        id, &vsn);
    if (rc != 0) {
        napi_value nullv = nullptr;
        napi_get_null(env, &nullv);
        return nullv;
    }

    napi_value result = nullptr;
    napi_create_object(env, &result);

    napi_value idBuf = nullptr;
    void* data = nullptr;
    napi_create_arraybuffer(env, 16, &data, &idBuf);
    if (data) std::memcpy(data, id, 16);
    napi_set_named_property(env, result, "id", idBuf);

    napi_value vsnVal = nullptr;
    napi_create_uint32(env, vsn, &vsnVal);
    napi_set_named_property(env, result, "volumeSerial", vsnVal);
    return result;
}

// inventoryWalk(root): Array<{path, length, attributes, lastWriteTime,
// creationTime, fileId: ArrayBuffer|null, volumeSerial, hasFileId}>.
// Synchronous; walks the tree with FILE_ID_INFO identity when readable.
napi_value inventory_walk_js(napi_env env, napi_callback_info info) {
    std::size_t argc = 1;
    napi_value argv[1];
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) {
        return throw_js(env, "inventoryWalk(root)");
    }
    const auto root = utf16_from_napi(env, argv[0]);
    if (root.empty()) return throw_js(env, "inventoryWalk requires a non-empty root");

    HarilContext probe;
    std::vector<InventoryRow> rows;
    try {
        rows = probe.walk_inventory(std::wstring_view(root));
    } catch (const std::exception& e) {
        return throw_js(env, e.what());
    }

    napi_value arr = nullptr;
    napi_create_array_with_length(env, rows.size(), &arr);
    for (std::uint32_t i = 0; i < rows.size(); i++) {
        const auto& r = rows[i];
        napi_value obj = nullptr;
        napi_create_object(env, &obj);

        napi_value pathVal = nullptr;
        napi_create_string_utf16(env,
            reinterpret_cast<const char16_t*>(r.path.data()),
            r.path.size(), &pathVal);
        napi_set_named_property(env, obj, "path", pathVal);

        napi_value num = nullptr;
        napi_create_uint32(env, r.length, &num);
        napi_set_named_property(env, obj, "length", num);
        napi_create_uint32(env, r.attributes, &num);
        napi_set_named_property(env, obj, "attributes", num);

        napi_value big = nullptr;
        napi_create_bigint_uint64(env, r.lastWriteTime, &big);
        napi_set_named_property(env, obj, "lastWriteTime", big);
        napi_create_bigint_uint64(env, r.creationTime, &big);
        napi_set_named_property(env, obj, "creationTime", big);

        if (r.hasFileId) {
            napi_value idBuf = nullptr;
            void* data = nullptr;
            napi_create_arraybuffer(env, 16, &data, &idBuf);
            if (data) std::memcpy(data, r.fileId128, 16);
            napi_set_named_property(env, obj, "fileId", idBuf);
        } else {
            napi_value nullv = nullptr;
            napi_get_null(env, &nullv);
            napi_set_named_property(env, obj, "fileId", nullv);
        }

        napi_create_uint32(env, r.volumeSerial, &num);
        napi_set_named_property(env, obj, "volumeSerial", num);
        napi_value flag = nullptr;
        napi_get_boolean(env, r.hasFileId, &flag);
        napi_set_named_property(env, obj, "hasFileId", flag);

        napi_set_element(env, arr, i, obj);
    }
    return arr;
}

}  // namespace

// ----------------------- Module registration -----------------------

NAPI_MODULE_INIT() {
    // EXPORT: create a JS function and attach it as an export property.
    // napi_create_function takes (env, name, length, cb, data, result).
    #define EXPORT(name, func)                                                                \
        do {                                                                                \
            napi_value __fn = nullptr;                                                    \
            if (napi_create_function(env, nullptr, NAPI_AUTO_LENGTH, func,                    \
                    nullptr, &__fn) != napi_ok) {                                          \
                napi_throw_error(env, nullptr, "napi_create_function failed");              \
                return nullptr;                                                          \
            }                                                                               \
            napi_set_named_property(env, exports, name, __fn);                              \
        } while (0)

    EXPORT("openSession",            open_session);
    EXPORT("closeSession",           close_session);
    EXPORT("sourceStatus",           source_status_js);
    EXPORT("etwStart",               etw_start_js);
    EXPORT("etwStop",                etw_stop_js);
    EXPORT("etwEventsLost",          atomic_counter_js<&HarilContext::etw_events_lost>);
    EXPORT("etwBuffersWritten",      atomic_counter_js<&HarilContext::etw_buffers_written>);
    EXPORT("etwEventsObserved",      atomic_counter_js<&HarilContext::etw_events_observed>);
    EXPORT("etwCandidatesOutOfScope", atomic_counter_js<&HarilContext::etw_candidates_out_of_scope>);
    EXPORT("usnStart",               usn_start_js);
    EXPORT("usnStop",                usn_stop_js);
    EXPORT("usnRecordsRead",         atomic_counter_js<&HarilContext::usn_records_read>);
    EXPORT("usnDroppedUnresolved",   atomic_counter_js<&HarilContext::usn_dropped_unresolved>);
    EXPORT("etwCandidatesWithoutPath", atomic_counter_js<&HarilContext::etw_candidates_without_path>);
    EXPORT("etwRingPushFailed",      atomic_counter_js<&HarilContext::etw_ring_push_failed>);
    EXPORT("etwPushAttempted",       atomic_counter_js<&HarilContext::etw_push_attempted>);
    EXPORT("etwKindZero",            atomic_counter_js<&HarilContext::etw_kind_zero>);
    EXPORT("etwAfterKind",           atomic_counter_js<&HarilContext::etw_after_kind>);
    EXPORT("etwAfterScope",          atomic_counter_js<&HarilContext::etw_after_scope>);
    EXPORT("ringHead",               atomic_counter_js<&HarilContext::ring_head>);
    EXPORT("ringTail",               atomic_counter_js<&HarilContext::ring_tail>);
    EXPORT("drain",                  drain_js);
    EXPORT("isAdmin",                is_admin_js);
    EXPORT("nowNs",                  now_ns_js);
    EXPORT("fsKind",                 fs_kind_js);
    EXPORT("relaunchElevated",       relaunch_elevated_js);
    EXPORT("getFileId",              get_file_id_js);
    EXPORT("inventoryWalk",          inventory_walk_js);

    #undef EXPORT

    napi_value version_str = nullptr;
    const char* version = "0.1.0";
    napi_create_string_utf8(env, version, NAPI_AUTO_LENGTH, &version_str);
    napi_set_named_property(env, exports, "version", version_str);
    return exports;
}