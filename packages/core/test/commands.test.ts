import { describe, test, expect } from "bun:test";
import { parseCommand, formatCommand } from "../src/commands/parse.ts";
import { complete } from "../src/commands/complete.ts";

describe("parse command", () => {
  test("parses command name only", () => {
    const r = parseCommand("ls");
    expect(r.name).toBe("ls");
    expect(r.positional).toEqual([]);
    expect(r.flags).toEqual({});
  });

  test("parses positional arguments", () => {
    const r = parseCommand("ls /foo/bar");
    expect(r.name).toBe("ls");
    expect(r.positional).toEqual(["/foo/bar"]);
  });

  test("parses flags", () => {
    const r = parseCommand("events --op Write --failed");
    expect(r.name).toBe("events");
    expect(r.flags["op"]).toBe("Write");
    expect(r.flags["failed"]).toBe(true);
  });

  test("parses quoted strings", () => {
    const r = parseCommand('search "node.exe"');
    expect(r.positional).toEqual(["node.exe"]);
  });

  test("round-trips with formatCommand", () => {
    const cmd = { name: "events", positional: [], flags: { op: "Write", failed: true } };
    const s = formatCommand(cmd);
    expect(s).toContain("--op=Write");
    expect(s).toContain("--failed");
  });
});

describe("complete", () => {
  const ctx = {
    cwd: "\\",
    knownDirectories: ["\\src", "\\docs", "\\tests"],
    knownFileKeys: [],
    knownProcessNames: ["node.exe", "haril.exe"],
    identityKinds: ["exact", "path"] as ("exact" | "path")[],
  };

  test("completes command names", () => {
    const out = complete("ls", 2, ctx);
    const names = out.map((c) => c.text);
    expect(names).toContain("ls");
    expect(names).not.toContain("events");
  });

  test("completes flag names", () => {
    const out = complete("events --op", 10, ctx);
    const flags = out.map((c) => c.text);
    expect(flags).toContain("--op");
  });

  test("completes positional path for cd", () => {
    const out = complete("cd ", 3, ctx);
    const paths = out.map((c) => c.text);
    expect(paths.length).toBeGreaterThan(0);
  });
});

describe("native bindings", () => {
  test("degrades gracefully when DLL is missing", async () => {
    // Pointing to a non-existent path should give us null.
    process.env["HARIL_NATIVE_DLL"] = "C:\\nonexistent\\haril_native.dll";
    // Re-import is awkward in TS; just check that the cached binding is null
    // and `requireNative` throws a structured error.
    const { requireNative } = await import("../src/ffi/bindings.ts");
    expect(() => requireNative("test")).toThrow(/haril_native\.node not available/);
  });
});