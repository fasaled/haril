/**
 * Regression test for the "text overlapping the next section" bug.
 *
 * When the right-hand detail panel is narrow (a typical ~80-col terminal
 * with the split layout), long titles ("Basic", "Path", "Create/Share",
 * "Source") used to overflow their box and visually merge with the first
 * label of the next line — e.g. "Basic" + "Kind:" rendered as "BaKind:".
 * Long values (process names, full observed paths) had the same problem.
 *
 * These tests render the components through Ink into a captured stdout
 * with `columns=80`, then assert that no line contains the known-bad
 * merged tokens and that the truncated values include the ellipsis.
 */

import { describe, test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { EventDetail } from "../src/tui/components/EventDetail.tsx";
import { EventList } from "../src/tui/components/EventList.tsx";

class CapturingStdout extends PassThrough {
  columns = 80;
  rows = 45;
  isTTY = true;
  buf: string[] = [];
  override write(chunk: unknown, ...rest: unknown[]): boolean {
    this.buf.push(String(chunk));
    return super.write(chunk as string, ...(rest as []));
  }
}

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "");
}

const fakeStdin = new PassThrough();
(fakeStdin as unknown as { isTTY: boolean }).isTTY = true;
(fakeStdin as unknown as { setRawMode: () => void }).setRawMode = () => {};

const longPath =
  "C:\\Users\\Francisco\\test_folder\\documents\\haril-20261005-224722.haril";
const longProcess = "SearchProtocolHost.exe";

const sampleEvent = {
  timestampNs: 1_000_000_000n,
  timestamp_ns: 1_000_000_000n,
  pid: 3112,
  tid: 17752547448283026n,
  eventKind: "Open" as const,
  source: "etw" as const,
  processImageName: longProcess,
  observedPath: longPath,
  ntStatus: null,
  irpPtr: null,
  byteOffset: null,
  byteLength: null,
  shareAccess: 7,
  createOptions: null,
  createDisposition: 20,
  sourceEventIndex: 310,
  fileKeyHash: "h" as never,
};

async function captureInstance(node: React.ReactElement): Promise<string> {
  const out = new CapturingStdout();
  const inst = render(node, { stdout: out, stdin: fakeStdin as never, exitOnCtrlC: false, patchConsole: false });
  // Give Ink a tick to paint.
  await new Promise((r) => setTimeout(r, 50));
  inst.unmount();
  return stripAnsi(out.buf.join(""));
}

describe("EventDetail narrow-panel rendering", () => {
  test("section titles do not bleed into the first label of the next line", async () => {
    const out = await captureInstance(
      React.createElement(EventDetail, {
        event: sampleEvent as never,
        baseNs: 0n,
        isFocused: true,
        fileKey: null,
        onClose: () => {},
        // Narrow right-hand panel: 80 * 40% = 32 cols, minus borders/padding.
        width: 28,
      }),
    );
    // These are the exact merged tokens the bug produced.
    expect(out).not.toContain("BaKind:");
    expect(out).not.toContain("PaObserved:");
    expect(out).not.toContain("CrShare:");
    expect(out).not.toContain("SoSource Index:");

    // The titles themselves should still appear (truncated or whole).
    expect(out).toContain("Basic");
    expect(out).toContain("Path");
    expect(out).toContain("Create/Share");
    expect(out).toContain("Source");
  });

  test("long observed path is clipped to the panel, not overflowing", async () => {
    const out = await captureInstance(
      React.createElement(EventDetail, {
        event: sampleEvent as never,
        baseNs: 0n,
        isFocused: true,
        fileKey: null,
        onClose: () => {},
        width: 28,
      }),
    );
    // The full path must NOT appear as one contiguous string — that means it
    // overflowed the panel. Instead, a clipped version with an ellipsis is OK.
    expect(out).not.toContain(longPath);
    expect(out).toMatch(/Observed:\s+C:\\Users\\Fran…/);
    // The "Path" section header must be visible (regression of the bug where
    // titles were clipped to empty strings and the section disappeared).
    expect(out).toContain("Path");
  });

  test("labels are aligned and section headers are never empty", async () => {
    const out = await captureInstance(
      React.createElement(EventDetail, {
        event: sampleEvent as never,
        baseNs: 0n,
        isFocused: true,
        fileKey: null,
        onClose: () => {},
        width: 28,
      }),
    );
    // All four section headers must be visible as whole words — the previous
    // version clipped "Create/Share" → "Create/Sh" and "Source" → "Sourc" etc.
    expect(out).toContain("Basic");
    expect(out).toContain("Path");
    expect(out).toContain("Create/Share");
    expect(out).toContain("Source");
    // Labels must appear aligned (the LABEL_W column pads to 12 cols).
    expect(out).toMatch(/Kind:\s+Open/);
    expect(out).toMatch(/Source:\s+ETW/);
    // Long values are clipped with an ellipsis at the value-column boundary.
    expect(out).toMatch(/Process:\s+SearchProtoco…/);
  });
});

describe("EventList narrow-panel rendering", () => {
  test("long process names are truncated to fit the panel", async () => {
    const out = await captureInstance(
      React.createElement(EventList, {
        events: [sampleEvent as never],
        baseNs: 0n,
        fileKey: null,
        selectedIndex: 0,
        onSelect: () => {},
        onNavigate: () => {},
        onFilter: () => {},
        isFocused: true,
        loading: false,
        // Narrow left-hand panel: 80 * 60% = 48 cols, minus borders/padding.
        width: 44,
      }),
    );
    // The full process name must not appear (it's wider than the panel budget).
    expect(out).not.toContain("SearchProtocolHost.exe");
    // The truncated form should be present.
    expect(out).toContain("…");
    // The fixed columns are still rendered.
    expect(out).toContain("Open");
    expect(out).toContain("ETW");
  });
});

describe("EventList accepts a parent-owned filtered list", () => {
  test("renders exactly the events passed via `events` prop, without re-applying filters", async () => {
    // Even though the filter prop asks for "Write" only, the parent has
    // already filtered the list and we pass only one event. The list must
    // render that single row and ignore the filter for rendering purposes.
    const out = await captureInstance(
      React.createElement(EventList, {
        events: [sampleEvent as never],
        baseNs: 0n,
        fileKey: null,
        selectedIndex: 0,
        onSelect: () => {},
        onNavigate: () => {},
        onFilter: () => {},
        isFocused: true,
        loading: false,
        filter: { kinds: ["Write"] },
        width: 80,
      }),
    );
    expect(out).toContain("Open");
  });
});