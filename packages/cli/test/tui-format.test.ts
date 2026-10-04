import { describe, test, expect } from "bun:test";
import { parseCommand } from "@haril-ts/core";
import { displayCwd, eventTimestampNs, formatEventTime, formatOffsetNs, toBigIntNs } from "../src/tui/format.ts";

describe("tui timestamp formatting", () => {
  test("accepts bigint, number and numeric string timestamps", () => {
    expect(toBigIntNs(5n)).toBe(5n);
    expect(toBigIntNs(5)).toBe(5n);
    expect(toBigIntNs("5")).toBe(5n);
    expect(toBigIntNs(undefined)).toBeNull();
    expect(toBigIntNs("abc")).toBeNull();
  });

  test("reads both live (timestamp_ns) and SQLite row (timestampNs) shapes", () => {
    expect(eventTimestampNs({ timestamp_ns: 10n })).toBe(10n);
    expect(eventTimestampNs({ timestampNs: 10 })).toBe(10n);
    expect(eventTimestampNs({})).toBeNull();
  });

  test("formats relative to the capture start without throwing", () => {
    expect(formatOffsetNs(1_234_000_000n)).toBe("+00:01.234");
    expect(formatOffsetNs(61_005_000_000n)).toBe("+01:01.005");
    expect(formatEventTime(3_000_000_000, 1_000_000_000n)).toBe("+00:02.000");
    expect(formatEventTime(undefined, 0n).trim()).toBe("?");
  });
});

describe("tui cwd display", () => {
  test("shows the process cwd when no package is loaded", () => {
    expect(displayCwd({ phase: "empty", cwd: "\\" })).toBe(process.cwd());
  });

  test("joins the package cwd to the capture root", () => {
    const manifest = { root: "C:\\Work\\Target" } as never;
    expect(displayCwd({ phase: "analyze", cwd: "\\", packageManifest: manifest })).toBe("C:\\Work\\Target");
    expect(displayCwd({ phase: "analyze", cwd: "\\src", packageManifest: manifest })).toBe("C:\\Work\\Target\\src");
  });
});

describe("command parsing of Windows paths", () => {
  test("keeps backslashes inside quotes", () => {
    const cmd = parseCommand('start-capture --root "C:\\Users\\me\\dir" --output out.haril');
    expect(cmd.flags["root"]).toBe("C:\\Users\\me\\dir");
  });

  test("still honours escaped quotes and JSON-style doubled backslashes", () => {
    expect(parseCommand('cd "a\\"b"').positional[0]).toBe('a"b');
    expect(parseCommand(`cd ${JSON.stringify("C:\\x\\y")}`).positional[0]).toBe("C:\\x\\y");
  });
});
