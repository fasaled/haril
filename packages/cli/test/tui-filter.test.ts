/**
 * Unit tests for the pure event-filtering helpers extracted from `App.tsx`.
 *
 * These exercise every branch of `applyEventFilter` and `reconcileSelection`
 * without mounting React, so the tests run in milliseconds and pin down the
 * exact semantics the TUI relies on for keeping the list and the detail
 * panel in sync.
 */

import { describe, test, expect } from "bun:test";
import {
  applyEventFilter,
  reconcileSelection,
  type EventFilter as Filter,
} from "../src/tui/filterEvents.ts";
import type { NormalizedEvent, EventKind } from "../../../core/src/index.ts";

function ev(overrides: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    timestampNs: 0n,
    timestamp_ns: 0n,
    pid: 1,
    tid: 1n,
    eventKind: "Open" as EventKind,
    source: "etw",
    processImageName: "node.exe",
    observedPath: null,
    ntStatus: null,
    irpPtr: null,
    byteOffset: null,
    byteLength: null,
    shareAccess: null,
    createOptions: null,
    createDisposition: null,
    sourceEventIndex: 0,
    fileKeyHash: "h",
    ...overrides,
  } as NormalizedEvent;
}

const sample: NormalizedEvent[] = [
  ev({ eventKind: "Open",     pid: 100, processImageName: "winword.exe",     ntStatus: 0   }),
  ev({ eventKind: "Create",   pid: 200, processImageName: "explorer.exe",    ntStatus: 0   }),
  ev({ eventKind: "Write",    pid: 200, processImageName: "explorer.exe",    ntStatus: 5   }),
  ev({ eventKind: "SetInfo",  pid: 300, processImageName: "SearchProtocolHost.exe", ntStatus: null }),
  ev({ eventKind: "Rename",   pid: 400, processImageName: "powershell.exe",  ntStatus: 0   }),
];

describe("applyEventFilter", () => {
  test("returns the input list unchanged for an empty filter", () => {
    expect(applyEventFilter(sample, {})).toEqual(sample);
  });

  test("returns the input list unchanged when filter is undefined", () => {
    expect(applyEventFilter(sample, undefined)).toEqual(sample);
  });

  test("filters by event kind", () => {
    const out = applyEventFilter(sample, { kinds: ["Write", "Rename"] });
    expect(out.map((e) => e.eventKind)).toEqual(["Write", "Rename"]);
  });

  test("empty kinds array means 'no kind filter' (returns everything)", () => {
    // The old implementation treated `kinds: []` as 'filter out everything'
    // because `kinds!.length` was 0, but it then short-circuited into the
    // reset/identity path. Pin the current behaviour explicitly.
    expect(applyEventFilter(sample, { kinds: [] })).toEqual(sample);
  });

  test("filters by failedOnly (ntStatus !== null && ntStatus !== 0)", () => {
    const out = applyEventFilter(sample, { failedOnly: true });
    expect(out.map((e) => e.eventKind)).toEqual(["Write"]); // ntStatus === 5
  });

  test("filters by pid", () => {
    const out = applyEventFilter(sample, { pid: 200 });
    expect(out).toHaveLength(2);
    expect(out.every((e) => e.pid === 200)).toBe(true);
  });

  test("filters by process name (case-insensitive substring)", () => {
    const out = applyEventFilter(sample, { process: "EXPLORER" });
    expect(out.map((e) => e.processImageName)).toEqual(["explorer.exe", "explorer.exe"]);
  });

  test("composes multiple filters with AND semantics", () => {
    const out = applyEventFilter(sample, { pid: 200, failedOnly: true });
    expect(out.map((e) => e.eventKind)).toEqual(["Write"]);
  });

  test("reset: true returns the full list regardless of other fields", () => {
    const out = applyEventFilter(sample, {
      reset: true,
      kinds: ["Open"],
      pid: 999, // would normally exclude all
    });
    expect(out).toEqual(sample);
  });

  test("does not mutate the input list", () => {
    const before = sample.slice();
    applyEventFilter(sample, { kinds: ["Write"] });
    expect(sample).toEqual(before);
  });
});

describe("reconcileSelection", () => {
  test("returns index 0 and first event when index is in range", () => {
    const r = reconcileSelection(sample, 2);
    expect(r.index).toBe(2);
    expect(r.event).toBe(sample[2]);
  });

  test("clamps a too-large index down to the last row", () => {
    const r = reconcileSelection(sample, 999);
    expect(r.index).toBe(sample.length - 1);
    expect(r.event).toBe(sample[sample.length - 1]);
  });

  test("clamps a negative index up to 0", () => {
    const r = reconcileSelection(sample, -3);
    expect(r.index).toBe(0);
    expect(r.event).toBe(sample[0]);
  });

  test("returns index 0 and event=null for an empty list", () => {
    const r = reconcileSelection([], 5);
    expect(r.index).toBe(0);
    expect(r.event).toBeNull();
  });
});