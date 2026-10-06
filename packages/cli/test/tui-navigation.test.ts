/**
 * Regression test for the navigation keymap of `EventList`.
 *
 * After reducing the keymap to "↑/↓ row, Ctrl+↑/↓ page, Ctrl+Home/End first/
 * last, Enter details", these tests assert the exact behaviour from the
 * parent's point of view: which `onNavigate` direction each keystroke
 * triggers, and that filter shortcuts (x, f) are independent of focus on
 * navigation.
 */

import { describe, test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import React, { useState } from "react";
import { render } from "ink";
import type { NormalizedEvent } from "../../../core/src/index.ts";
import { EventList } from "../src/tui/components/EventList.tsx";

function mkEvent(i: number): NormalizedEvent {
  return {
    timestamp_ns: BigInt(i),
    timestampNs: BigInt(i),
    pid: 100,
    tid: 100n,
    eventKind: "Open",
    source: "etw",
    processImageName: `proc-${i}.exe`,
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

function makeHarness(events: NormalizedEvent[]) {
  const navCalls: Array<"up" | "down" | "first" | "last" | "pageUp" | "pageDown"> = [];
  const filterCalls: Array<Record<string, unknown>> = [];
  let selectCalls = 0;

  const Wrap: React.FC<{ focused: boolean }> = ({ focused }) => {
    const [idx, setIdx] = useState(0);
    return React.createElement(EventList, {
      events,
      baseNs: 0n,
      fileKey: null,
      selectedIndex: idx,
      onSelect: () => { selectCalls++; },
      onNavigate: (dir) => {
        navCalls.push(dir);
        setIdx((prev) => {
          switch (dir) {
            case "up":       return Math.max(0, prev - 1);
            case "down":     return Math.min(events.length - 1, prev + 1);
            case "first":    return 0;
            case "last":     return events.length - 1;
            case "pageUp":   return Math.max(0, prev - 15);
            case "pageDown": return Math.min(events.length - 1, prev + 15);
          }
        });
      },
      onFilter: (f) => { filterCalls.push({ ...f }); },
      isFocused: focused,
      loading: false,
      width: 100,
    });
  };
  return { Wrap, navCalls, filterCalls, getSelectCalls: () => selectCalls };
}

async function pressKeys(stdin: PassThrough, seq: string[], perKeyMs = 30): Promise<void> {
  for (const seq0 of seq) {
    stdin.write(seq0);
    await new Promise((r) => setTimeout(r, perKeyMs));
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

describe("EventList navigation input handler", () => {
  test("ArrowDown moves the selection forward", async () => {
    const events = Array.from({ length: 10 }, (_, i) => mkEvent(i));
    const { Wrap, navCalls } = makeHarness(events);
    const stdin = makeStdin();
    const inst = render(React.createElement(Wrap, { focused: true }), {
      stdout: new PassThrough() as never,
      stdin: stdin as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await pressKeys(stdin, ["\u001b[B", "\u001b[B", "\u001b[B"]);
    expect(navCalls).toEqual(["down", "down", "down"]);
    inst.unmount();
  });

  test("ArrowUp moves the selection backward", async () => {
    const events = Array.from({ length: 10 }, (_, i) => mkEvent(i));
    const { Wrap, navCalls } = makeHarness(events);
    const stdin = makeStdin();
    const inst = render(React.createElement(Wrap, { focused: true }), {
      stdout: new PassThrough() as never,
      stdin: stdin as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await pressKeys(stdin, ["\u001b[A", "\u001b[A"]);
    expect(navCalls).toEqual(["up", "up"]);
    inst.unmount();
  });

  test("Ctrl+ArrowDown jumps a page (15 rows) forward", async () => {
    const events = Array.from({ length: 50 }, (_, i) => mkEvent(i));
    const { Wrap, navCalls } = makeHarness(events);
    const stdin = makeStdin();
    const inst = render(React.createElement(Wrap, { focused: true }), {
      stdout: new PassThrough() as never,
      stdin: stdin as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await pressKeys(stdin, ["\u001b[1;5B"]);
    expect(navCalls).toEqual(["pageDown"]);
    inst.unmount();
  });

  test("Ctrl+ArrowUp jumps a page (15 rows) backward", async () => {
    const events = Array.from({ length: 50 }, (_, i) => mkEvent(i));
    const { Wrap, navCalls } = makeHarness(events);
    const stdin = makeStdin();
    const inst = render(React.createElement(Wrap, { focused: true }), {
      stdout: new PassThrough() as never,
      stdin: stdin as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await pressKeys(stdin, ["\u001b[1;5A"]);
    expect(navCalls).toEqual(["pageUp"]);
    inst.unmount();
  });

  test("Ctrl+Home jumps to the first row", async () => {
    const events = Array.from({ length: 50 }, (_, i) => mkEvent(i));
    const { Wrap, navCalls } = makeHarness(events);
    const stdin = makeStdin();
    const inst = render(React.createElement(Wrap, { focused: true }), {
      stdout: new PassThrough() as never,
      stdin: stdin as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await pressKeys(stdin, ["\u001b[1;5H"]);
    expect(navCalls).toEqual(["first"]);
    inst.unmount();
  });

  test("Ctrl+End jumps to the last row", async () => {
    const events = Array.from({ length: 50 }, (_, i) => mkEvent(i));
    const { Wrap, navCalls } = makeHarness(events);
    const stdin = makeStdin();
    const inst = render(React.createElement(Wrap, { focused: true }), {
      stdout: new PassThrough() as never,
      stdin: stdin as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await pressKeys(stdin, ["\u001b[1;5F"]);
    expect(navCalls).toEqual(["last"]);
    inst.unmount();
  });

  test("Home/End without Ctrl do NOT navigate (regression: only Ctrl variants move)", async () => {
    const events = Array.from({ length: 50 }, (_, i) => mkEvent(i));
    const { Wrap, navCalls } = makeHarness(events);
    const stdin = makeStdin();
    const inst = render(React.createElement(Wrap, { focused: true }), {
      stdout: new PassThrough() as never,
      stdin: stdin as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await pressKeys(stdin, ["\u001b[H", "\u001b[F"]);
    expect(navCalls).toEqual([]);
    inst.unmount();
  });

  test("vim-style j/k no longer move the selection", async () => {
    const events = Array.from({ length: 10 }, (_, i) => mkEvent(i));
    const { Wrap, navCalls } = makeHarness(events);
    const stdin = makeStdin();
    const inst = render(React.createElement(Wrap, { focused: true }), {
      stdout: new PassThrough() as never,
      stdin: stdin as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await pressKeys(stdin, ["j", "j", "k"]);
    expect(navCalls).toEqual([]);
    inst.unmount();
  });

  test("x toggles failedOnly, f clears the filter", async () => {
    const events = Array.from({ length: 4 }, (_, i) => mkEvent(i));
    const { Wrap, filterCalls } = makeHarness(events);
    const stdin = makeStdin();
    const inst = render(React.createElement(Wrap, { focused: true }), {
      stdout: new PassThrough() as never,
      stdin: stdin as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await pressKeys(stdin, ["x", "f"]);
    expect(filterCalls).toEqual([
      { failedOnly: true },
      { reset: true },
    ]);
    inst.unmount();
  });

  test("Enter triggers onSelect for the current row", async () => {
    const events = Array.from({ length: 4 }, (_, i) => mkEvent(i));
    const { Wrap, getSelectCalls } = makeHarness(events);
    const stdin = makeStdin();
    const inst = render(React.createElement(Wrap, { focused: true }), {
      stdout: new PassThrough() as never,
      stdin: stdin as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await pressKeys(stdin, ["\r"]);
    expect(getSelectCalls()).toBe(1);
    inst.unmount();
  });

  test("input is ignored when the panel is not focused", async () => {
    const events = Array.from({ length: 4 }, (_, i) => mkEvent(i));
    const { Wrap, navCalls, filterCalls } = makeHarness(events);
    const stdin = makeStdin();
    const inst = render(React.createElement(Wrap, { focused: false }), {
      stdout: new PassThrough() as never,
      stdin: stdin as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await pressKeys(stdin, ["\u001b[B", "x"]);
    expect(navCalls).toEqual([]);
    expect(filterCalls).toEqual([]);
    inst.unmount();
  });
});