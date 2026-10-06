/**
 * Visual inspection: render the EventList with raw colour output enabled
 * (using `forceColor`) and dump the FRAMES so we can see exactly which row
 * is highlighted and which is not, with the real user's fixture.
 */

import { describe, test } from "bun:test";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { createSession, parseCommand } from "@haril-ts/core";
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

describe("colour-inspect repro", () => {
  test("dump Ink frames after 20 ArrowDown + Ctrl+End to inspect highlight", async () => {
    const events = await loadEvents();
    if (events.length === 0) return;

    const Wrap: React.FC = () => {
      const [idx, setIdx] = React.useState(0);
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
      // Force colour output so we can inspect the highlight SGR codes.
      ...({ forceColor: true } as any),
    });

    // 20 ArrowDown.
    for (let i = 0; i < 20; i++) {
      stdin.write("\u001b[B");
      await new Promise((r) => setTimeout(r, 40));
    }
    // Then Ctrl+End.
    stdin.write("\u001b[1;5F");
    await new Promise((r) => setTimeout(r, 80));

    // Dump all raw frames for inspection.
    const all = out.chunks.join("");
    const sgrPattern = /\x1b\[[0-9;]+m/g;
    const sgrs = [...all.matchAll(sgrPattern)];
    console.log("=== unique SGR codes used: " + new Set(sgrs.map((s) => s[0])).size);
    console.log("=== first 10 unique SGR:");
    for (const s of [...new Set(sgrs.map((s) => s[0]))].slice(0, 10)) console.log("    " + JSON.stringify(s));

    inst.unmount();
  });
});