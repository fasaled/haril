import { describe, test, expect } from "bun:test";
import { parseCommand, formatCommand } from "../src/commands/parse.ts";
import { complete, getVisibleSuggestionsWindow, applyCompletion } from "../src/commands/complete.ts";
import { CommandQueue } from "../src/commands/queue.ts";
import { native } from "../src/ffi/bindings.ts";

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

  test("filters commands by phase", () => {
    const emptyOut = complete("", 0, { ...ctx, phase: "empty" });
    const emptyNames = emptyOut.map((c) => c.text);
    expect(emptyNames).toContain("open");
    expect(emptyNames).toContain("start-capture");
    expect(emptyNames).toContain("ls");
    expect(emptyNames).toContain("cd");
    expect(emptyNames).toContain("pwd");
    expect(emptyNames).not.toContain("events");

    const liveOut = complete("", 0, { ...ctx, phase: "live-capture" });
    const liveNames = liveOut.map((c) => c.text);
    expect(liveNames).toContain("stop-capture");
    expect(liveNames).not.toContain("open");
    expect(liveNames).toContain("ls");
  });

  test("completes heuristics and zoom options", () => {
    const h = complete("heuristics ", 11, ctx);
    expect(h.map((c) => c.text)).toEqual(["on", "off"]);

    const z = complete("zoom ", 5, ctx);
    expect(z.map((c) => c.text)).toEqual(["in", "out", "reset"]);
  });

  test("getVisibleSuggestionsWindow fits within maxWidth and shifts around active item", () => {
    const list = ["apple", "banana", "cherry", "date", "elderberry", "fig", "grape"];
    const win = getVisibleSuggestionsWindow(list, 3, 25);
    expect(win.items.length).toBeGreaterThan(0);
    expect(win.items.some((i) => i.isSelected)).toBe(true);
    expect(win.hasPrevious || win.hasNext).toBe(true);
  });

  test("applyCompletion replaces trailing token correctly", () => {
    expect(applyCompletion("eve", "events")).toBe("events ");
    expect(applyCompletion("events --o", "--op")).toBe("events --op ");
    expect(applyCompletion("open src\\", "src\\core\\")).toBe("open src\\core\\");
  });
});

describe("CommandQueue", () => {
  test("enqueues, dequeues, and tracks length", () => {
    const q = new CommandQueue();
    expect(q.length).toBe(0);

    const c1 = q.enqueue("ls");
    const c2 = q.enqueue("events");
    expect(q.length).toBe(2);
    expect(q.entries()).toHaveLength(2);

    const d1 = q.dequeue();
    expect(d1?.id).toBe(c1.id);
    expect(d1?.input).toBe("ls");
    expect(q.length).toBe(1);

    const d2 = q.dequeue();
    expect(d2?.id).toBe(c2.id);
    expect(q.length).toBe(0);
    expect(q.dequeue()).toBeUndefined();
  });

  test("removes and moves queued commands", () => {
    const q = new CommandQueue();
    q.enqueue("first");
    q.enqueue("second");
    q.enqueue("third");

    q.move(1, 2);
    expect(q.entries().map((e) => e.input)).toEqual(["second", "first", "third"]);

    const removed = q.remove(2);
    expect(removed?.input).toBe("first");
    expect(q.entries().map((e) => e.input)).toEqual(["second", "third"]);

    const cleared = q.clear();
    expect(cleared).toBe(2);
    expect(q.length).toBe(0);
  });
});

describe("native bindings", () => {
  test("degrades gracefully when DLL is missing", async () => {
    // Only meaningful when the addon is missing; if it loaded, skip.
    if (native()) return;
    // Pointing to a non-existent path should give us null.
    process.env["HARIL_NATIVE_DLL"] = "C:\\nonexistent\\haril_native.dll";
    // Re-import is awkward in TS; just check that the cached binding is null
    // and `requireNative` throws a structured error.
    const { requireNative } = await import("../src/ffi/bindings.ts");
    expect(() => requireNative("test")).toThrow(/haril_native\.node not available/);
  });
});