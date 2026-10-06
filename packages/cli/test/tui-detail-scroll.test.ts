/**
 * Tests for the EventDetail scrollable viewport.
 *
 * The user reported the detail looked "irregular" between events of the
 * same kind (Open/Close): content taller than the panel was clipped by
 * Yoga with no way to scroll, so different events showed different,
 * unpredictable slices of their data. The fix flattens sections into a
 * deterministic row list and slices it with a keyboard-driven scroll.
 *
 * These tests render the real component through Ink with a small `height`
 * and drive ↑/↓/Ctrl+End/Ctrl+Home through the fake stdin.
 */

import { describe, test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import type { NormalizedEvent } from "../../../core/src/index.ts";
import { EventDetail } from "../src/tui/components/EventDetail.tsx";

class CaptureStdout extends PassThrough {
  columns = 120;
  rows = 45;
  isTTY = true;
  chunks: string[] = [];
  override write(chunk: unknown, ...rest: unknown[]): boolean {
    this.chunks.push(String(chunk));
    return super.write(chunk as string, ...(rest as []));
  }
  allText(): string {
    return this.chunks
      .join("")
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b\][^\x07]*\x07/g, "");
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

function mkEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    timestamp_ns: 1858842282810n,
    timestampNs: 1858842282810n,
    pid: 12988,
    tid: 8900,
    eventKind: "Open",
    source: "etw",
    processImageName: "bun.exe",
    observedPath: "\\Word document.docx",
    ntStatus: 0,
    irpPtr: 0xffff880d6df3c800n,
    byteOffset: 0n,
    byteLength: 4096n,
    shareAccess: 7,
    createOptions: 0x60,
    createDisposition: 1,
    sourceEventIndex: 97,
    fileKeyHash: "h",
    ...overrides,
  } as NormalizedEvent;
}

/** All sections present -> Basic(title+7) + gap + Path(title+1) + gap +
 *  I/O(title+2) + gap + Create/Share(title+3) + gap + Source(title+1) = 23 rows. */
const FULL_EVENT = mkEvent();

function renderDetail(height: number | undefined, stdin: PassThrough, stdout: CaptureStdout) {
  return render(
    React.createElement(EventDetail, {
      event: FULL_EVENT,
      baseNs: 0n,
      fileKey: null,
      isFocused: true,
      onClose: () => {},
      width: 46,
      ...(height !== undefined ? { height } : {}),
    }),
    { stdout: stdout as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false },
  );
}

/** Returns the last fully-painted box ("╭…╯") from the concatenated output,
 *  so assertions reflect the final frame rather than the whole history. */
function lastFrameText(stdout: CaptureStdout): string {
  const text = stdout.allText();
  const boxes = text.split("╭");
  const last = boxes[boxes.length - 1] ?? "";
  const end = last.indexOf("╯");
  return end >= 0 ? last.slice(0, end) : last;
}

describe("EventDetail scrollable viewport", () => {
  test("without height prop, everything renders (legacy behaviour)", async () => {
    const stdout = new CaptureStdout();
    const inst = renderDetail(undefined, makeStdin(), stdout);
    await new Promise((r) => setTimeout(r, 60));
    const text = stdout.allText();
    expect(text).toContain("Basic");
    expect(text).toContain("Kind:");
    expect(text).toContain("Source Index:");
    inst.unmount();
  });

  test("small panel shows scroll indicator and hides the tail", async () => {
    const stdout = new CaptureStdout();
    const stdin = makeStdin();
    // Panel height 12 -> content rows = 12 - 3 = 9 -> viewport 8 + indicator.
    const inst = renderDetail(12, stdin, stdout);
    await new Promise((r) => setTimeout(r, 60));
    const text = stdout.allText();

    // Top of the content is visible...
    expect(text).toContain("Kind:");
    // ...and the indicator reports the visible window out of the total.
    expect(text).toMatch(/↑\/↓ scroll 1–8\/23/);
    // The tail sections are NOT painted while unscrolled.
    expect(text).not.toContain("Source Index:");
    inst.unmount();
  });

  test("Ctrl+End reveals the last section", async () => {
    const stdout = new CaptureStdout();
    const stdin = makeStdin();
    const inst = renderDetail(12, stdin, stdout);
    await new Promise((r) => setTimeout(r, 60));
    stdin.write("\u001b[1;5F"); // Ctrl+End
    await new Promise((r) => setTimeout(r, 80));
    const text = lastFrameText(stdout);
    expect(text).toContain("Source Index:");
    expect(text).toMatch(/↑\/↓ scroll 16–23\/23/);
    inst.unmount();
  });

  test("Ctrl+Home returns to the top", async () => {
    const stdout = new CaptureStdout();
    const stdin = makeStdin();
    const inst = renderDetail(12, stdin, stdout);
    await new Promise((r) => setTimeout(r, 60));
    stdin.write("\u001b[1;5F"); // Ctrl+End
    await new Promise((r) => setTimeout(r, 60));
    stdin.write("\u001b[1;5H"); // Ctrl+Home
    await new Promise((r) => setTimeout(r, 80));
    const text = lastFrameText(stdout);
    expect(text).toContain("Kind:");
    expect(text).not.toContain("Source Index:");
    inst.unmount();
  });

  test("ArrowDown scrolls one row at a time", async () => {
    const stdout = new CaptureStdout();
    const stdin = makeStdin();
    const inst = renderDetail(12, stdin, stdout);
    await new Promise((r) => setTimeout(r, 60));
    stdin.write("\u001b[B"); // ArrowDown
    await new Promise((r) => setTimeout(r, 80));
    const text = lastFrameText(stdout);
    expect(text).toMatch(/↑\/↓ scroll 2–9\/23/);
    inst.unmount();
  });

  test("scroll resets to the top when the event changes", async () => {
    const stdout = new CaptureStdout();
    const stdin = makeStdin();

    const Host: React.FC<{ event: NormalizedEvent }> = ({ event }) =>
      React.createElement(EventDetail, {
        event,
        baseNs: 0n,
        fileKey: null,
        isFocused: true,
        onClose: () => {},
        width: 46,
        height: 12,
      });

    const inst = render(React.createElement(Host, { event: FULL_EVENT }), {
      stdout: stdout as never,
      stdin: stdin as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await new Promise((r) => setTimeout(r, 60));
    stdin.write("\u001b[1;5F"); // scroll to the bottom
    await new Promise((r) => setTimeout(r, 80));
    expect(stdout.allText()).toContain("Source Index:");

    // Swap in a different event object -> scroll must reset to top.
    inst.rerender(React.createElement(Host, { event: mkEvent({ eventKind: "Close", sourceEventIndex: 99 }) }));
    await new Promise((r) => setTimeout(r, 80));
    const text = lastFrameText(stdout);
    expect(text).toMatch(/↑\/↓ scroll 1–8\/23/);
    // Kind of the new event is at the top again.
    expect(text).toContain("Close");
    inst.unmount();
  });

  test("input is ignored when the panel is not focused", async () => {
    const stdout = new CaptureStdout();
    const stdin = makeStdin();
    const inst = render(
      React.createElement(EventDetail, {
        event: FULL_EVENT,
        baseNs: 0n,
        fileKey: null,
        isFocused: false,
        onClose: () => {},
        width: 46,
        height: 12,
      }),
      { stdout: stdout as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false },
    );
    await new Promise((r) => setTimeout(r, 60));
    stdin.write("\u001b[1;5F"); // Ctrl+End — must do nothing
    await new Promise((r) => setTimeout(r, 80));
    const text = lastFrameText(stdout);
    expect(text).not.toContain("Source Index:");
    inst.unmount();
  });

  test("label column fits 'Source Index:' without truncation", async () => {
    const stdout = new CaptureStdout();
    const inst = renderDetail(undefined, makeStdin(), stdout);
    await new Promise((r) => setTimeout(r, 60));
    const text = stdout.allText();
    // Regression: with LABEL_W=12 the label was clipped to "Source Inde…".
    expect(text).toContain("Source Index:");
    expect(text).not.toContain("Source Inde…");
    inst.unmount();
  });
});
