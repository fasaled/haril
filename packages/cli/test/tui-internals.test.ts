/**
 * Capture internal EventList state via HARIL_DEBUG_EVENTLIST.
 * Looks at every painted frame and reports what scrollOffset and
 * selectedIndex were when each frame was produced. If we see frames
 * where selectedIndex is outside [scrollOffset, scrollOffset+EVH),
 * that's the bug.
 */

import { describe, test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import React, { useState } from "react";
import { render } from "ink";
import { createSession, parseCommand } from "@haril-ts/core";
import { EventList } from "../src/tui/components/EventList.tsx";
import type { NormalizedEvent } from "../../../core/src/index.ts";

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

async function loadEvents(): Promise<NormalizedEvent[]> {
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
  })) as NormalizedEvent[];
}

interface DbgLine {
  targetOffset: number;
  scrollOffset: number;
  selectedIndex: number;
  effectiveVisibleHeight: number;
  totalEvents: number;
}

function parseDbg(stripped: string): DbgLine[] {
  const out: DbgLine[] = [];
  for (const m of stripped.matchAll(/\[DBG targetOffset=(\d+) scrollOffset=(\d+) selectedIndex=(\d+) effectiveVisibleHeight=(\d+) totalEvents=(\d+)\]/g)) {
    out.push({
      targetOffset: parseInt(m[1]!, 10),
      scrollOffset: parseInt(m[2]!, 10),
      selectedIndex: parseInt(m[3]!, 10),
      effectiveVisibleHeight: parseInt(m[4]!, 10),
      totalEvents: parseInt(m[5]!, 10),
    });
  }
  return out;
}

describe("EventList internal state across frames", () => {
  test("with the user fixture, no frame has selectedIndex outside [scrollOffset, scrollOffset+EVH)", async () => {
    process.env.HARIL_DEBUG_EVENTLIST = "1";
    try {
      const events = await loadEvents();
      if (events.length === 0) return;

      const Wrap: React.FC = () => {
        const [idx, setIdx] = useState(0);
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

      // Press Down enough to scroll the entire 32-event list.
      for (let i = 0; i < events.length + 1; i++) {
        stdin.write("\u001b[B");
        await new Promise((r) => setTimeout(r, 25));
      }
      // Then Ctrl+End.
      stdin.write("\u001b[1;5F");
      await new Promise((r) => setTimeout(r, 80));

      const all = out.chunks.join("");
      const stripped = all
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
        .replace(/\x1b\][^\x07]*\x07/g, "");
      const dbg = parseDbg(stripped);
      console.log("=== captured " + dbg.length + " debug snapshots ===");
      for (const d of dbg.slice(-30)) console.log("    " + JSON.stringify(d));

      // Find any frame where selectedIndex is outside the visible window
      // (i.e. outside [targetOffset, targetOffset + effectiveVisibleHeight)).
      const offenders = dbg.filter(
        (d) => d.selectedIndex < d.targetOffset || d.selectedIndex >= d.targetOffset + d.effectiveVisibleHeight,
      );
      console.log("=== frames with selectedIndex outside visible window: " + offenders.length);
      for (const o of offenders) console.log("    " + JSON.stringify(o));
      expect(offenders.length).toBe(0);

      inst.unmount();
    } finally {
      delete process.env.HARIL_DEBUG_EVENTLIST;
    }
  });
});