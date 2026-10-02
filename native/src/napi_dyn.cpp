// napi_dyn.cpp — host-resolved N-API forwarders.
//
// Problem: linking against node.lib bakes a hard dependency on
// `node.exe` into our binary. Under Bun (bun.exe host) the loader
// then resolves `node.exe` from PATH — possibly the wrong
// architecture — and LoadLibrary fails with ERROR_BAD_EXE_FORMAT.
//
// Solution: do NOT link node.lib at all. Instead, define each napi_*
// function we call as a forwarder that resolves the real address
// from the host process (GetModuleHandle(NULL) + GetProcAddress) on
// first use. Both node.exe and bun.exe export the N-API entry points,
// so the same binary loads under either host.
//
// The signatures below are copied verbatim from
// node-api-headers/include/js_native_api.h.

#include <node_api.h>

#include <windows.h>

namespace {

HMODULE napi_host_module() {
    static HMODULE h = GetModuleHandleW(NULL);
    return h;
}

template <typename Fn>
Fn napi_load(const char* name) {
    return reinterpret_cast<Fn>(GetProcAddress(napi_host_module(), name));
}

}  // namespace

extern "C" {

#define NAPI_FORWARD(ret, name, params, args)                    \
    ret NAPI_CDECL name params {                                 \
        using Fn = ret(NAPI_CDECL*) params;                      \
        static Fn fn = napi_load<Fn>(#name);                     \
        return fn args;                                         \
    }

NAPI_FORWARD(napi_status, napi_create_array_with_length,
             (napi_env env, size_t length, napi_value* result),
             (env, length, result))

NAPI_FORWARD(napi_status, napi_create_arraybuffer,
             (napi_env env, size_t byte_length, void** data, napi_value* result),
             (env, byte_length, data, result))

NAPI_FORWARD(napi_status, napi_create_bigint_uint64,
             (napi_env env, uint64_t value, napi_value* result),
             (env, value, result))

NAPI_FORWARD(napi_status, napi_create_function,
             (napi_env env, const char* utf8name, size_t length, napi_callback cb, void* data, napi_value* result),
             (env, utf8name, length, cb, data, result))

NAPI_FORWARD(napi_status, napi_create_int32,
             (napi_env env, int32_t value, napi_value* result),
             (env, value, result))

NAPI_FORWARD(napi_status, napi_create_object,
             (napi_env env, napi_value* result),
             (env, result))

NAPI_FORWARD(napi_status, napi_create_string_utf16,
             (napi_env env, const char16_t* str, size_t length, napi_value* result),
             (env, str, length, result))

NAPI_FORWARD(napi_status, napi_create_string_utf8,
             (napi_env env, const char* str, size_t length, napi_value* result),
             (env, str, length, result))

NAPI_FORWARD(napi_status, napi_create_uint32,
             (napi_env env, uint32_t value, napi_value* result),
             (env, value, result))

NAPI_FORWARD(napi_status, napi_get_boolean,
             (napi_env env, bool value, napi_value* result),
             (env, value, result))

NAPI_FORWARD(napi_status, napi_get_cb_info,
             (napi_env env, napi_callback_info cbinfo, size_t* argc, napi_value* argv, napi_value* this_arg, void** data),
             (env, cbinfo, argc, argv, this_arg, data))

NAPI_FORWARD(napi_status, napi_get_null,
             (napi_env env, napi_value* result),
             (env, result))

NAPI_FORWARD(napi_status, napi_get_value_int32,
             (napi_env env, napi_value value, int32_t* result),
             (env, value, result))

NAPI_FORWARD(napi_status, napi_get_value_string_utf16,
             (napi_env env, napi_value value, char16_t* buf, size_t bufsize, size_t* result),
             (env, value, buf, bufsize, result))

NAPI_FORWARD(napi_status, napi_remove_wrap,
             (napi_env env, napi_value js_object, void** result),
             (env, js_object, result))

NAPI_FORWARD(napi_status, napi_set_element,
             (napi_env env, napi_value object, uint32_t index, napi_value value),
             (env, object, index, value))

NAPI_FORWARD(napi_status, napi_set_named_property,
             (napi_env env, napi_value object, const char* utf8name, napi_value value),
             (env, object, utf8name, value))

NAPI_FORWARD(napi_status, napi_throw_error,
             (napi_env env, const char* code, const char* msg),
             (env, code, msg))

NAPI_FORWARD(napi_status, napi_typeof,
             (napi_env env, napi_value value, napi_valuetype* result),
             (env, value, result))

NAPI_FORWARD(napi_status, napi_unwrap,
             (napi_env env, napi_value js_object, void** result),
             (env, js_object, result))

NAPI_FORWARD(napi_status, napi_wrap,
             (napi_env env, napi_value js_object, void* native_object, node_api_basic_finalize finalize_cb, void* finalize_hint, napi_ref* result),
             (env, js_object, native_object, finalize_cb, finalize_hint, result))

}  // extern "C"
