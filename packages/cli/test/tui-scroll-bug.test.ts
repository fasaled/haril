/**
 * Reproduction / regression tests for the EventList scroll bug.
 *
 * User-reported issue: "When I press ArrowDown past the bottom of the
 * visible window, sometimes the highlight disappears. When I navigate to
 * the last event, the highlight also disappears."
 *
 * We can't easily inspect Ink's ANSI colour output (the test rig uses a
 * non-TTY PassThrough, so Ink strips colour codes), so we assert the
 * invariants that the bug *must* break if it really exists:
 *
 *   INV-1: After N presses of ArrowDown, the parent's selectedIndex is N.
 *   INV-2: The selected event is visible in the rendered viewport.
 *   INV-3: The viewport always contains at most VISIBLE consecutive rows
 *          (no gap, no overlap, no empty slice for non-empty input).
 *   INV-4: The first visible row index is in
 *          [selectedIndex - VISIBLE + 1, selectedIndex].
 */

import { describe, test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import React, { useState } from "react";
import { render } from "ink";
import type { NormalizedEvent } from "../../../core/src/index.ts";
import { EventList } from "../src/tui/components/EventList.tsx";

interface CapturedFrame {
  raw: string;
  plain: string;
}

class CaptureStdout extends PassThrough {
  columns = 120;
  rows = 20;
  isTTY = true;
  frames: string[] = [];
  override write(chunk: unknown, ...rest: unknown[]): boolean {
    this.frames.push(String(chunk));
    if (this.frames.length > 600) this.frames.splice(0, this.frames.length - 600);
    return super.write(chunk as string, ...(rest as []));
  }
  distinctFrames(): CapturedFrame[] {
    const seen = new Set<string>();
    const out: CapturedFrame[] = [];
    for (const f of this.frames) {
      if (seen.has(f)) continue;
      seen.add(f);
      out.push({ raw: f, plain: stripAnsi(f) });
    }
    return out;
  }
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

function makeStdin(): PassThrough {
  const s = new PassThrough();
  (s as unknown as { isTTY: boolean }).isTTY = true;
  (s as unknown as { setRawMode: () => void }).setRawMode = () => {};
  (s as unknown as { ref: () => unknown }).ref = () => s;
  (s as unknown as { unref: () => unknown }).unref = () => s;
  return s;
}

function mkEvent(i: number): NormalizedEvent {
  return {
    timestamp_ns: BigInt(i) * 1_000_000_000n,
    timestampNs: BigInt(i) * 1_000_000_000n,
    pid: 100,
    tid: 100n,
    eventKind: "Open",
    source: "etw",
    processImageName: `proc-${String(i).padStart(3, "0")}.exe`,
    observedPath: null,
    ntStatus: null,
    irpPtr: null,
    byteOffset: null,
    byteLength: null,
    shareAccess: null,
    createOptions: null,
    createDisposition: null,
    sourceEventIndex: i,
    fileKeyHash: "h",
  } as NormalizedEvent;
}

const VISIBLE = 8;            // total panel height passed by the parent
const EFFECTIVE = VISIBLE - 3; // painted rows: panel - border(2) - single-line keybindings footer(1)

/** Returns the indices of the proc-NNN rows currently visible on screen. */
function visibleIndices(text: string): number[] {
  const matches = text.matchAll(/\bproc-(\d+)\.exe\b/g);
  const out: number[] = [];
  for (const m of matches) out.push(parseInt(m[1]!, 10));
  return out;
}

interface HarnessState {
  selectedIdx: number;
}

function makeHarness(events: NormalizedEvent[]): { Wrap: React.FC; state: HarnessState } {
  const state: HarnessState = { selectedIdx: -1 };
  const Wrap: React.FC = () => {
    const [idx, setIdx] = useState(0);
    state.selectedIdx = idx;
    return React.createElement(EventList, {
      events,
      baseNs: 0n,
      fileKey: null,
      selectedIndex: idx,
      onSelect: () => {},
      // Reproduce the EXACT page-jump size used in App.tsx: a fixed 15,
      // regardless of the actual viewport height. This mismatch between
      // the keyboard-driven jump size (15) and the visible row count
      // (8 in our test rig) is the most likely culprit behind the
      // user-reported "highlight disappears" bug.
      onNavigate: (dir) => setIdx((prev) => {
        switch (dir) {
          case "down":     return Math.min(events.length - 1, prev + 1);
          case "up":       return Math.max(0, prev - 1);
          case "first":    return 0;
          case "last":     return events.length - 1;
          case "pageUp":   return Math.max(0, prev - 15);
          case "pageDown": return Math.min(events.length - 1, prev + 15);
        }
      }),
      onFilter: () => {},
      isFocused: true,
      loading: false,
      width: 100,
      visibleHeight: VISIBLE,
    });
  };
  return { Wrap, state };
}

function lastContentFrame(out: CaptureStdout): string {
  const frames = out.distinctFrames();
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i]!.plain.includes("proc-")) return frames[i]!.plain;
  }
  return "";
}

describe("EventList scroll/highlight invariants", () => {
  test("12 ArrowDown presses leave selectedIndex=12 visible", async () => {
    const events = Array.from({ length: 30 }, (_, i) => mkEvent(i));
    const { Wrap, state } = makeHarness(events);
    const out = new CaptureStdout();
    const stdin = makeStdin();
    const inst = render(React.createElement(Wrap), {
      stdout: out as never, stdin: stdin as never,
      exitOnCtrlC: false, patchConsole: false,
    });
    for (let i = 0; i < 12; i++) {
      stdin.write("\u001b[B");
      await new Promise((r) => setTimeout(r, 50));
    }
    // INV-1: state matches the presses.
    expect(state.selectedIdx).toBe(12);
    // INV-2: the row at selectedIndex is on screen.
    const plain = lastContentFrame(out);
    expect(plain).toContain("proc-012.exe");
    // INV-3: contiguous, no gaps, exactly EFFECTIVE rows.
    const visible = visibleIndices(plain);
    expect(visible.length).toBe(EFFECTIVE);
    for (let i = 1; i < visible.length; i++) {
      expect(visible[i]!).toBe(visible[i - 1]! + 1);
    }
    // INV-4: the selected row is inside the visible window.
    expect(visible[0]!).toBeLessThanOrEqual(12);
    expect(visible[visible.length - 1]!).toBeGreaterThanOrEqual(12);
    inst.unmount();
  });

  test("Ctrl+End leaves the last event visible", async () => {
    const events = Array.from({ length: 30 }, (_, i) => mkEvent(i));
    const { Wrap, state } = makeHarness(events);
    const out = new CaptureStdout();
    const stdin = makeStdin();
    const inst = render(React.createElement(Wrap), {
      stdout: out as never, stdin: stdin as never,
      exitOnCtrlC: false, patchConsole: false,
    });
    stdin.write("\u001b[1;5F"); // Ctrl+End
    await new Promise((r) => setTimeout(r, 100));
    expect(state.selectedIdx).toBe(29);
    const plain = lastContentFrame(out);
    expect(plain).toContain("proc-029.exe");
    const visible = visibleIndices(plain);
    expect(visible[visible.length - 1]!).toBe(29);
    inst.unmount();
  });

  test("Ctrl+Home leaves the first event visible", async () => {
    const events = Array.from({ length: 30 }, (_, i) => mkEvent(i));
    const { Wrap, state } = makeHarness(events);
    // Start the selection somewhere in the middle.
    const out = new CaptureStdout();
    const stdin = makeStdin();
    // Move selection to 20 first by writing 20 ArrowDowns.
    const inst = render(React.createElement(Wrap), {
      stdout: out as never, stdin: stdin as never,
      exitOnCtrlC: false, patchConsole: false,
    });
    for (let i = 0; i < 20; i++) {
      stdin.write("\u001b[B");
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(state.selectedIdx).toBe(20);
    // Now Ctrl+Home.
    stdin.write("\u001b[1;5H");
    await new Promise((r) => setTimeout(r, 100));
    expect(state.selectedIdx).toBe(0);
    const plain = lastContentFrame(out);
    expect(plain).toContain("proc-000.exe");
    const visible = visibleIndices(plain);
    expect(visible[0]!).toBe(0);
    expect(visible[visible.length - 1]!).toBe(EFFECTIVE - 1);
    inst.unmount();
  });

  test("Ctrl+ArrowDown (pageDown) keeps the selection in the visible window", async () => {
    const events = Array.from({ length: 50 }, (_, i) => mkEvent(i));
    const { Wrap, state } = makeHarness(events);
    const out = new CaptureStdout();
    const stdin = makeStdin();
    const inst = render(React.createElement(Wrap), {
      stdout: out as never, stdin: stdin as never,
      exitOnCtrlC: false, patchConsole: false,
    });
    stdin.write("\u001b[1;5B"); // Ctrl+Down = pageDown (+15 in App.tsx)
    await new Promise((r) => setTimeout(r, 100));
    expect(state.selectedIdx).toBe(15);
    const plain = lastContentFrame(out);
    const visible = visibleIndices(plain);
    // The viewport must contain the selected row, no matter the page size.
    expect(visible).toContain(15);
    inst.unmount();
  });

  test("With a filter active, the highlighted row stays within the actually-rendered area", async () => {
    // Reproduces the original bug: the parent passes the *total* panel
    // height, but the panel also occupies some rows with a filter banner
    // and the keyboard hints footer. If the component treats the full
    // height as "visible rows", `scrollOffset` is computed against a window
    // larger than the one Ink actually paints, so the selected row falls
    // past the bottom of the rendered area and appears unhighlighted.
    const events = Array.from({ length: 30 }, (_, i) => mkEvent(i));
    let state: HarnessState = { selectedIdx: -1 };

    const Wrap: React.FC = () => {
      const [idx, setIdx] = useState(0);
      state.selectedIdx = idx;
      return React.createElement(EventList, {
        events,
        baseNs: 0n,
        fileKey: null,
        selectedIndex: idx,
        onSelect: () => {},
        onNavigate: (dir) => setIdx((prev) => {
          switch (dir) {
            case "down":     return Math.min(events.length - 1, prev + 1);
            case "up":       return Math.max(0, prev - 1);
            case "first":    return 0;
            case "last":     return events.length - 1;
            case "pageUp":   return Math.max(0, prev - 15);
            case "pageDown": return Math.min(events.length - 1, prev + 15);
          }
        }),
        onFilter: () => {},
        isFocused: true,
        loading: false,
        width: 100,
        // App.tsx passes mainContentLines, which is the *total* panel
        // height; the actual list area is smaller because the panel also
        // renders the border, the filter banner and the keybindings.
        visibleHeight: 12,
        filter: { failedOnly: true },
      });
    };

    const out = new CaptureStdout();
    const stdin = makeStdin();
    const inst = render(React.createElement(Wrap), {
      stdout: out as never, stdin: stdin as never,
      exitOnCtrlC: false, patchConsole: false,
    });
    // Page jump straight to a row near the bottom (Ctrl+End).
    stdin.write("\u001b[1;5F");
    await new Promise((r) => setTimeout(r, 100));
    expect(state.selectedIdx).toBe(events.length - 1);
    const plain = lastContentFrame(out);
    const visible = visibleIndices(plain);
    // The last event must be present in the rendered output. With the bug
    // (no overhead subtraction) the viewport would start at
    // `29 - 12 + 1 = 18` and Ink would only render 12 - 3 = 9 rows starting
    // from offset 18, but the scroll would say proc-018..proc-029 are
    // visible — yet the last 3 (proc-027..proc-029) would actually be
    // outside the painted region. With `visibleHeight = 12`, the panel
    // really has 9 event-list slots, meaning the last index shown should
    // be at most 22 (offset = 14, rows 14..18 = 5 rows).
    // Either way, the selected row MUST be in `visible`.
    expect(visible).toContain(events.length - 1);
    inst.unmount();
  });
});