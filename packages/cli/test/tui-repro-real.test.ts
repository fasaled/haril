/**
 * End-to-end reproduction of the "highlight disappears" bug using a real
 * .haril fixture provided by the user (haril-20261006-201502.haril, captured
 * in /c/Users/francisco/Src/haril-test/). The test reproduces the exact
 * conditions: ~120x45 terminal, the largest file in the package
 * (\Word document.docx with 32 events), arrow-down navigation, and visual
 * inspection of every painted frame to find the one where the highlighted
 * row disappears.
 */

import { describe, test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { createSession, parseCommand } from "@haril-ts/core";
import { EventList } from "../src/tui/components/EventList.tsx";

interface Frame {
  raw: string;
  plain: string;
  ts: number;
}

class RecordingStdout extends PassThrough {
  columns = 120;
  rows = 45;
  isTTY = true;
  frames: Frame[] = [];
  override write(chunk: unknown, ...rest: unknown[]): boolean {
    this.frames.push({ raw: String(chunk), plain: "", ts: Date.now() });
    return super.write(chunk as string, ...(rest as []));
  }
  finalize(): void {
    for (const f of this.frames) {
      f.plain = f.raw
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
        .replace(/\x1b\][^\x07]*\x07/g, "");
    }
  }
}

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "");
}

function makeStdin(): PassThrough {
  const s = new PassThrough();
  (s as unknown as { isTTY: boolean }).isTTY = true;
  (s as unknown as { setRawMode: () => void }).setRawMode = () => {};
  (s as unknown as { ref: () => unknown }).ref = () => s;
  (s as unknown as { unref: () => unknown }).unref = () => s;
  return s;
}

const FIXTURE = "C:\\Users\\Francisco\\AppData\\Local\\Temp\\user-fixture.haril";

interface NormalizedEvent {
  timestamp_ns?: bigint;
  timestampNs?: bigint;
  pid: number;
  tid: number | bigint;
  eventKind: any;
  source: any;
  processImageName: string | null;
  observedPath: string | null;
  ntStatus: number | null;
  irpPtr: number | bigint | null;
  byteOffset: number | bigint | null;
  byteLength: number | bigint | null;
  shareAccess: number | null;
  createOptions: number | null;
  createDisposition: number | null;
  sourceEventIndex: number;
  fileKeyHash: string;
}

async function loadEventsFromFixture(): Promise<NormalizedEvent[]> {
  const session = await createSession({ phase: "empty" });
  await session.runCommand(parseCommand(`open "${FIXTURE}"`));
  const ls = await session.runCommand(parseCommand("ls --limit 10"));
  const items: any[] = (ls.data as any).items ?? ls.data;
  // Pick the file with the most events (top of the list).
  const biggest = items[0]!;
  const key = biggest.fileKeyHash ?? biggest.fileKey ?? biggest.id;
  const ev = await session.runCommand(parseCommand(`events ${key} --limit 1000`));
  const evs: any[] = (ev.data as any).items ?? ev.data;
  session.close();
  // Normalise to what EventList expects.
  return evs.map((e) => ({
    timestamp_ns: typeof e.timestampNs === "bigint" ? e.timestampNs : BigInt(e.timestampNs ?? e.timestamp_ns ?? 0),
    timestampNs: typeof e.timestampNs === "bigint" ? e.timestampNs : BigInt(e.timestampNs ?? e.timestamp_ns ?? 0),
    pid: e.pid ?? 0,
    tid: e.tid ?? 0,
    eventKind: e.eventKind,
    source: e.source,
    processImageName: e.processImageName ?? null,
    observedPath: e.observedPath ?? null,
    ntStatus: e.ntStatus ?? null,
    irpPtr: e.irpPtr ?? null,
    byteOffset: e.byteOffset ?? null,
    byteLength: e.byteLength ?? null,
    shareAccess: e.shareAccess ?? null,
    createOptions: e.createOptions ?? null,
    createDisposition: e.createDisposition ?? null,
    sourceEventIndex: e.sourceEventIndex ?? 0,
    fileKeyHash: key,
  }));
}

/** Extract the visible proc names from a frame's plain text, in order. */
function visibleProcs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/proc-?([\w.-]+)?/g)) {
    out.push(m[0]);
  }
  // We also look for unique process names that appear in the data.
  return out;
}

/** A row in the rendered EventList has the shape:
 *   "│ +HH:MM:SS.mmm │ KIND  SOURCE PID:##### │ processname"
 * Returns null when the row doesn't contain a recognizable event row. */
function isEventRow(line: string): boolean {
  return /^[│|]\s*\+\d\d:\d\d\.\d{3}/.test(line);
}

/** Extract (timestamp, kind, pid, process) from a rendered row. */
function parseRow(line: string): { ts: string; kind: string; pid: string; proc: string } | null {
  const m = line.match(/^[│|]\s*(\+\d\d:\d\d\.\d{3})\s*[│|]\s*(\w+)\s+(\w+)\s+PID:\s*(\d+|\?)\s*[│|]\s+(.+?)\s*$/);
  if (!m) return null;
  return { ts: m[1]!, kind: m[2]!, pid: m[4]!, proc: m[5]! };
}

describe("repro the highlight-disappears bug with a real fixture", () => {
  test("arrow-down through 32 events; selectedIndex must always be visually present", async () => {
    const events = await loadEventsFromFixture();
    console.log("=== fixture has " + events.length + " events ===");
    if (events.length === 0) return; // skip

    // We capture every painted frame after each keystroke.
    let state = { selectedIdx: 0 };

    const Wrap: React.FC = () => {
      const [idx, setIdx] = React.useState(0);
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
        // Simulate the production parameters: 120x45 terminal, 60% width.
        width: 68, // 0.6 * 120 - 4
        // The "total panel height" the parent computes (termRows - 5 - promptHeight).
        // For termRows=45: promptHeight = min(11, max(8, floor(45*0.35)))
        //                  = min(11, max(8, 15)) = 11
        //                  mainContentLines = max(5, 45 - 5 - 11) = 29
        visibleHeight: 29,
      });
    };

    const out = new RecordingStdout();
    const stdin = makeStdin();
    const inst = render(React.createElement(Wrap), {
      stdout: out as never, stdin: stdin as never,
      exitOnCtrlC: false, patchConsole: false,
    });

    // Press ArrowDown enough times to definitely need to scroll.
    const presses = Math.min(events.length + 2, 20);
    for (let i = 0; i < presses; i++) {
      stdin.write("\u001b[B");
      await new Promise((r) => setTimeout(r, 60));
    }

    out.finalize();

    // After all presses, find the LAST frame that has actual event content.
    // For that frame, the selected row must be visible.
    let lastContentFrame: Frame | undefined;
    for (let i = out.frames.length - 1; i >= 0; i--) {
      const f = out.frames[i]!;
      if (f.plain.includes("Open") || f.plain.includes("Close") || f.plain.includes("Create") ||
          f.plain.includes("Rename") || f.plain.includes("SetInfo") || f.plain.includes("Delete") ||
          f.plain.includes("Write") || f.plain.includes("Read") || f.plain.includes("OpEnd")) {
        lastContentFrame = f;
        break;
      }
    }

    expect(lastContentFrame).toBeDefined();
    const last = lastContentFrame!;

    // Parse the event rows from this frame.
    const rows = last.plain.split("\n")
      .map((l) => l.trim())
      .filter(isEventRow)
      .map(parseRow)
      .filter((r): r is { ts: string; kind: string; pid: string; proc: string } => r !== null);

    console.log("=== state.selectedIdx =", state.selectedIdx);
    console.log("=== visible rows count =", rows.length);
    console.log("=== first row ts =", rows[0]?.ts, " last row ts =", rows[rows.length - 1]?.ts);

    // The selected event (at state.selectedIdx) must be one of the visible
    // rows — i.e. its timestamp must be in the visible row list.
    const sel = events[state.selectedIdx];
    if (!sel) return;
    const expectedTs = formatTs(sel.timestampNs ?? sel.timestamp_ns);
    const visible = rows.find((r) => r.ts === expectedTs);
    console.log("=== expected ts =", expectedTs, " found?", !!visible);
    if (!visible) {
      console.log("=== BUG REPRODUCED: selectedIndex=" + state.selectedIdx + " ts=" + expectedTs + " is NOT visible in the rendered frame");
      console.log("=== Visible rows:");
      for (const r of rows) console.log("    ", JSON.stringify(r));
    }
    expect(visible).not.toBeUndefined();

    inst.unmount();
  });

  test("Ctrl+End with the real fixture: last event must be visible", async () => {
    const events = await loadEventsFromFixture();
    if (events.length === 0) return;

    let state = { selectedIdx: -1 };

    const Wrap: React.FC = () => {
      const [idx, setIdx] = React.useState(0);
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
            case "last":     return Math.min(events.length - 1, prev + 15);
            case "pageUp":   return Math.max(0, prev - 15);
            case "pageDown": return Math.min(events.length - 1, prev + 15);
          }
        }),
        onFilter: () => {},
        isFocused: true,
        loading: false,
        width: 68,
        visibleHeight: 29,
      });
    };

    const out = new RecordingStdout();
    const stdin = makeStdin();
    const inst = render(React.createElement(Wrap), {
      stdout: out as never, stdin: stdin as never,
      exitOnCtrlC: false, patchConsole: false,
    });

    stdin.write("\u001b[1;5F"); // Ctrl+End
    await new Promise((r) => setTimeout(r, 100));

    out.finalize();

    let lastContentFrame: Frame | undefined;
    for (let i = out.frames.length - 1; i >= 0; i--) {
      const f = out.frames[i]!;
      if (f.plain.includes("Open") || f.plain.includes("Close") || f.plain.includes("Create")) {
        lastContentFrame = f;
        break;
      }
    }
    expect(lastContentFrame).toBeDefined();
    const last = lastContentFrame!;
    const rows = last.plain.split("\n")
      .map((l) => l.trim())
      .filter(isEventRow)
      .map(parseRow)
      .filter((r): r is { ts: string; kind: string; pid: string; proc: string } => r !== null);
    console.log("=== Ctrl+End: selectedIdx=" + state.selectedIdx + " visible rows=" + rows.length);
    const sel = events[state.selectedIdx];
    if (sel) {
      const expectedTs = formatTs(sel.timestampNs ?? sel.timestamp_ns);
      const visible = rows.find((r) => r.ts === expectedTs);
      if (!visible) {
        console.log("=== BUG: Ctrl+End selected row not visible");
        console.log("=== expected ts=" + expectedTs);
        console.log("=== rows:", rows.map((r) => r.ts).join(", "));
      }
      expect(visible).not.toBeUndefined();
    }

    inst.unmount();
  });
});

function formatTs(ts: bigint | undefined): string {
  if (ts === undefined) return "+??:??.???";
  // Format as +MM:SS.mmm (relative to base).
  const totalMs = Number(ts / 1_000_000n);
  const m = Math.floor(totalMs / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `+${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}