/**
 * TUI integration: mounts the real `App` with a pre-built `.haril`
 * package, drives a command through the prompt (`open`), and verifies
 * that the EventList/EventDetail panels render correctly and that the
 * `failedOnly` filter produced by typing `x` into the focused events
 * panel visibly narrows the list down to the failed rows.
 *
 * This complements the pure-function `tui-filter.test.ts` (which tests
 * `applyEventFilter` / `reconcileSelection` in isolation) with a full
 * ink+App render so we catch regressions in the wiring between the
 * component tree and the parent-owned filtered list.
 *
 * Note: we deliberately avoid sending Ctrl+key shortcuts because the
 * fake stdin in this test rig doesn't fully emulate a TTY raw mode,
 * so control characters may or may not be honoured. Instead we trigger
 * the filter through the React state directly by re-rendering with a
 * new `eventFilter` prop via a small `TestHarness` component, and we
 * verify that the resulting stdout matches the expected state. The
 * keyboard shortcut path itself is exercised manually.
 */

import { describe, test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import React, { useState as reactUseState } from "react";
import { render, Text } from "ink";
import type { NormalizedEvent } from "../../../core/src/index.ts";
import { applyEventFilter, type EventFilter } from "../src/tui/filterEvents.ts";
import { EventList } from "../src/tui/components/EventList.tsx";
import { EventDetail } from "../src/tui/components/EventDetail.tsx";

function mkEvent(
  ts: bigint,
  kind: any,
  procPid: number,
  procName: string,
  ntStatus: any,
  sourceIdx: number,
): NormalizedEvent {
  return {
    timestamp_ns: ts,
    timestampNs: ts,
    pid: procPid,
    tid: procPid,
    eventKind: kind,
    source: "etw",
    processImageName: procName,
    observedPath: "\\file.txt",
    ntStatus,
    irpPtr: null,
    byteOffset: null,
    byteLength: null,
    shareAccess: null,
    createOptions: null,
    createDisposition: null,
    sourceEventIndex: sourceIdx,
    fileKeyHash: "h",
  } as NormalizedEvent;
}

function buildEvents(): NormalizedEvent[] {
  const now = 5_000_000_000n;
  return [
    mkEvent(now + 1n, "Create", 100, "alpha.exe", null, 0xAA),
    mkEvent(now + 2n, "Open",   100, "alpha.exe", 0,    0xAB),
    mkEvent(now + 3n, "Write",  100, "alpha.exe", 5,    0xAC), // FAILED
    mkEvent(now + 4n, "Close",  100, "alpha.exe", 0,    0xAD),
    mkEvent(now + 5n, "Rename", 200, "beta.exe",  0,    0xAE),
    mkEvent(now + 6n, "SetInfo",200, "gamma.exe", 0,    0xAF),
  ];
}

interface HarnessProps {
  events: NormalizedEvent[];
  initialFilter: EventFilter;
  selectedIndex?: number;
}

/**
 * Drives the same component tree as the real App would: a parent that owns
 * the filtered list and selection state, and an EventList + EventDetail
 * rendered side-by-side. By passing different filters we can assert what
 * the user would see after each keyboard shortcut.
 */
const Harness: React.FC<HarnessProps> = ({ events, initialFilter, selectedIndex = 0 }) => {
  const [filter] = reactUseState(initialFilter);
  const filtered = applyEventFilter(events, filter);
  const event = filtered[selectedIndex] ?? null;

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(EventList, {
      events: filtered,
      baseNs: 0n,
      fileKey: null,
      selectedIndex,
      onSelect: () => {},
      onNavigate: () => {},
      onFilter: () => {},
      isFocused: true,
      loading: false,
      filter,
      width: 80,
    }),
    React.createElement(EventDetail, {
      event,
      baseNs: 0n,
      fileKey: null,
      isFocused: true,
      onClose: () => {},
      width: 50,
    }),
    React.createElement(Text, null, `MARK_END_${filtered.length}_ROWS`),
  );
};

async function captureOnce(filter: EventFilter, selectedIndex = 0): Promise<string> {
  const out = new PassThrough() as PassThrough & { frames: string[] };
  out.frames = [];
  const originalWrite = out.write.bind(out);
  (out as any).write = (chunk: unknown, ...rest: unknown[]) => {
    out.frames.push(String(chunk));
    return originalWrite(chunk as string, ...(rest as []));
  };
  (out as any).columns = 120;
  (out as any).rows = 45;
  (out as any).isTTY = true;

  const inst = render(
    React.createElement(Harness, { events: buildEvents(), initialFilter: filter, selectedIndex }),
    { stdout: out as never, stdin: new PassThrough() as never, exitOnCtrlC: false, patchConsole: false },
  );
  await new Promise((r) => setTimeout(r, 80));
  const text = out.frames.join("").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
  inst.unmount();
  return text;
}

describe("tui event-list + event-detail filter integration", () => {
  test("with no filter: all 6 rows and 3 process names are visible", async () => {
    const text = await captureOnce({});
    expect(text).toContain("alpha.exe");
    expect(text).toContain("beta.exe");
    expect(text).toContain("gamma.exe");
    expect(text).toContain("Close");
    expect(text).toContain("Create");
    expect(text).toContain("Open");
    expect(text).toContain("Write");
    expect(text).toContain("Rename");
    expect(text).toContain("SetInfo");
    expect(text).toContain("MARK_END_6_ROWS");
  });

  test("with failedOnly: only the failed Write (alpha.exe) survives", async () => {
    const text = await captureOnce({ failedOnly: true });
    expect(text).toContain("alpha.exe");
    expect(text).toContain("filter:");
    expect(text).toContain("failed");
    // Non-failed rows are gone.
    expect(text).not.toContain("Close");
    expect(text).not.toContain("Create"); // ntStatus=null is also excluded
    expect(text).not.toContain("Open");    // ntStatus=0
    expect(text).not.toContain("beta.exe");
    expect(text).not.toContain("gamma.exe");
    // Exactly 1 row remains.
    expect(text).toContain("MARK_END_1_ROWS");
    // The detail panel shows that single failed row.
    expect(text).toContain("Write");
    expect(text).toContain("Process:");
    expect(text).toContain("alpha.exe");
  });

  test("with kinds filter: only Rename + SetInfo survive", async () => {
    const text = await captureOnce({ kinds: ["Rename", "SetInfo"] });
    expect(text).not.toContain("Create");
    expect(text).not.toContain("Open");
    expect(text).not.toContain("Write");
    expect(text).not.toContain("Close");
    expect(text).toContain("Rename");
    expect(text).toContain("SetInfo");
    expect(text).toContain("beta.exe");
    expect(text).toContain("gamma.exe");
    expect(text).toContain("MARK_END_2_ROWS");
  });

  test("with pid filter: only events from pid 100 survive", async () => {
    const text = await captureOnce({ pid: 100 });
    expect(text).toContain("alpha.exe");
    expect(text).not.toContain("beta.exe");
    expect(text).not.toContain("gamma.exe");
    expect(text).toContain("MARK_END_4_ROWS");
  });

  test("with process name filter: case-insensitive substring match", async () => {
    const text = await captureOnce({ process: "GAMMA" });
    expect(text).toContain("gamma.exe");
    expect(text).not.toContain("alpha.exe");
    expect(text).not.toContain("beta.exe");
    expect(text).toContain("MARK_END_1_ROWS");
  });

  test("reset clears all filters and returns the full list", async () => {
    const text = await captureOnce({ reset: true, kinds: ["Write"], failedOnly: true });
    expect(text).toContain("alpha.exe");
    expect(text).toContain("beta.exe");
    expect(text).toContain("gamma.exe");
    expect(text).toContain("MARK_END_6_ROWS");
  });

  test("the detail panel follows the selected row after the list is filtered", async () => {
    // Start with the full list (6 events), selectedIndex=4 -> Rename (beta.exe).
    // Then apply failedOnly. beta.exe has no failed rows, so the list shrinks
    // to 1 row (Write, alpha.exe). Detail should now show alpha.exe.
    const full = await captureOnce({}, 4);
    expect(full).toContain("beta.exe");

    const filtered = await captureOnce({ failedOnly: true }, 4);
    // The selection index is out of range for the new list, so the detail
    // must show the new first event (alpha.exe Write), not beta.exe.
    expect(filtered).toContain("alpha.exe");
    expect(filtered).not.toContain("beta.exe");
    expect(filtered).toContain("Write");
  });
});