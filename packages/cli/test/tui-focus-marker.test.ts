/**
 * Live reproduction with the user's fixture, using a "focus probe" wrapper
 * that wraps the real EventList and adds a debug marker around the row
 * that the component THINKS is selected.
 *
 * This test does not rely on SGR colour codes (which Ink strips in our
 * non-TTY rig). Instead, it reads the `selectedIndex` prop that EventList
 * receives and compares it against the row indices that EventList
 * renders. If `selectedIndex` is NOT in the rendered slice, the auto-
 * scroll is broken.
 */

import { describe, test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import React, { useState } from "react";
import { render } from "ink";
import { createSession, parseCommand } from "@haril-ts/core";
import { EventList } from "../src/tui/components/EventList.tsx";
import type { NormalizedEvent } from "../../../core/src/index.ts";
import { formatEventTime, eventTimestampNs } from "../src/tui/format.ts";

interface EventWithTs extends NormalizedEvent {
  timestamp_ns: bigint;
  timestampNs: bigint;
  eventKind: any;
  source: any;
  processImageName: string | null;
}

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

async function loadEvents(): Promise<EventWithTs[]> {
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
  })) as EventWithTs[];
}

describe("focus-marker repro", () => {
  test("after 33 ArrowDown presses, the selectedIndex row IS rendered", async () => {
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

    for (let i = 0; i < events.length + 1; i++) {
      stdin.write("\u001b[B");
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 80));

    // Find the last meaningful frame.
    const all = out.chunks.join("");
    const stripped = all
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b\][^\x07]*\x07/g, "");

    const lines = stripped.split("\n").map((l) => l.trim());
    const visibleTimestamps: string[] = [];
    for (const l of lines) {
      const m = l.match(/^[│|]\s*\+(\d\d:\d\d\.\d{3})/);
      if (m) visibleTimestamps.push("+" + m[1]!);
    }
    console.log("=== visible timestamps count:", visibleTimestamps.length);
    console.log("=== first visible:", visibleTimestamps[0]);
    console.log("=== last visible:", visibleTimestamps[visibleTimestamps.length - 1]);

    // The selected row (index=31) has a known timestamp. Compute it.
    const sel = events[events.length - 1]!;
    const ts = formatEventTime(eventTimestampNs(sel), 0n);
    console.log("=== expected last ts:", ts);
    expect(visibleTimestamps).toContain(ts);

    inst.unmount();
  });
});