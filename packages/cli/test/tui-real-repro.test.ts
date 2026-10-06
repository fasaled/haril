/**
 * Real reproduction: load the user's .haril fixture, mount the real App,
 * navigate with arrow keys, and capture EVERY frame.
 *
 * This test focuses on the inter-frame inconsistency between the React
 * render that updates `selectedIndex` and the auto-scroll useEffect that
 * updates `scrollOffset`. If there's a frame where scrollOffset is stale
 * relative to selectedIndex, the selected row falls outside the visible
 * window and Ink paints it without highlight — which matches the user's
 * "highlight disappears" report.
 */

import { describe, test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { createSession } from "@haril-ts/core";
import { EventList } from "../src/tui/components/EventList.tsx";

class RecordingStdout extends PassThrough {
  columns = 120;
  rows = 45;
  isTTY = true;
  chunks: string[] = [];
  override write(chunk: unknown, ...rest: unknown[]): boolean {
    this.chunks.push(String(chunk));
    return super.write(chunk as string, ...(rest as []));
  }
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
  timestamp_ns: bigint;
  pid: number;
  eventKind: any;
  source: any;
  processImageName: string | null;
  sourceEventIndex: number;
}

async function loadEvents(): Promise<NormalizedEvent[]> {
  const { parseCommand } = await import("@haril-ts/core");
  const session = await createSession({ phase: "empty" });
  await session.runCommand(parseCommand(`open "${FIXTURE}"`));
  const ls = await session.runCommand(parseCommand("ls --limit 10"));
  const items: any[] = (ls.data as any).items ?? ls.data;
  const biggest = items[0]!;
  const key = biggest.fileKeyHash ?? biggest.fileKey ?? biggest.id;
  const ev = await session.runCommand(parseCommand(`events ${key} --limit 1000`));
  const evs: any[] = (ev.data as any).items ?? ev.data;
  session.close();
  return evs.map((e) => ({
    timestamp_ns: typeof e.timestampNs === "bigint" ? e.timestampNs : BigInt(e.timestampNs ?? e.timestamp_ns ?? 0),
    pid: e.pid ?? 0,
    eventKind: e.eventKind,
    source: e.source,
    processImageName: e.processImageName ?? null,
    sourceEventIndex: e.sourceEventIndex ?? 0,
  }));
}

describe("real-flu repro", () => {
  test("with the user fixture, after pressing ArrowDown N times the selectedIndex IS within the visible window", async () => {
    const events = await loadEvents();
    console.log("=== fixture has " + events.length + " events ===");
    if (events.length === 0) return;

    let state = { selectedIdx: 0, lastFramePlain: "" };

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
        width: 68,
        visibleHeight: 25,
      });
    };

    const out = new RecordingStdout();
    const stdin = makeStdin();
    const inst = render(React.createElement(Wrap), {
      stdout: out as never, stdin: stdin as never,
      exitOnCtrlC: false, patchConsole: false,
    });

    // Press Down N times and then dump state.
    for (let i = 0; i < events.length + 1; i++) {
      stdin.write("\u001b[B");
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 50));

    // Find the last meaningful frame.
    const all = out.chunks.join("");
    const stripped = all
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b\][^\x07]*\x07/g, "");

    state.lastFramePlain = stripped;
    console.log("=== state.selectedIdx =", state.selectedIdx);
    console.log("=== last frame length =", stripped.length);

    // INVARIANT: the row at selectedIndex must be visible in the rendered
    // output. We check by the timestamp that would be displayed.
    const sel = events[state.selectedIdx];
    if (!sel) return;
    const totalMs = Number((sel.timestamp_ns) / 1_000_000n);
    const m = Math.floor(totalMs / 60_000);
    const s = Math.floor((totalMs % 60_000) / 1000);
    const ms = totalMs % 1000;
    const expectedTs = `+${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;

    // The expected row pattern: "| +MM:SS.mmm │ KIND SOURCE PID:NNNNN │ <procname>"
    // Find any line with this timestamp.
    const rowRe = new RegExp(`^[│|]\\s*\\${expectedTs}\\s*[│|]`, "m");
    const found = rowRe.test(stripped);
    console.log("=== expected ts =", expectedTs, " found?", found);

    if (!found) {
      console.log("=== BUG REPRODUCED ===");
      console.log("=== Visible event rows in last frame: ===");
      const lines = stripped.split("\n");
      for (const l of lines) {
        if (/^[│|]\s*\+\d\d:\d\d\.\d{3}/.test(l.trim())) console.log("    " + l.trim());
      }
    }

    expect(found).toBe(true);

    inst.unmount();
  });
});