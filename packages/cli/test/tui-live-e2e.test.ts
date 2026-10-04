/**
 * TUI end-to-end: drives the real `App` through Ink with fake TTY streams.
 *
 * Types `start-capture` in the prompt, creates files while the window is
 * open, and checks that (1) files and events show up live on screen,
 * (2) the capture finishes and switches to analysis without exiting, and
 * (3) the analysis view renders event timelines (regression: the
 * BigInt/number mix in timestamp formatting used to crash the render).
 */

import { describe, test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import { mkdtempSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import React from "react";
import { render } from "ink";
import { createSession } from "@haril-ts/core";
import { App } from "../src/tui/App.tsx";

class FakeStdout extends PassThrough {
  columns = 160;
  rows = 45;
  isTTY = true;
  frames: string[] = [];
  override write(chunk: unknown, ...rest: unknown[]): boolean {
    this.frames.push(String(chunk));
    if (this.frames.length > 400) this.frames.splice(0, this.frames.length - 400);
    return super.write(chunk as string, ...(rest as []));
  }
  recent(n = 40): string {
    return stripAnsi(this.frames.slice(-n).join(""));
  }
}

class FakeStdin extends PassThrough {
  isTTY = true;
  setRawMode(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(100);
  }
  return pred();
}

describe("tui live capture e2e", () => {
  test(
    "shows files and events live, then analyzes without exiting",
    async () => {
      const watched = mkdtempSync(join(tmpdir(), "haril-tui-watch-"));
      const outDir = mkdtempSync(join(tmpdir(), "haril-tui-out-"));
      const output = join(outDir, "tui.haril");
      writeFileSync(join(watched, "seed.txt"), "seed\n");

      const stdout = new FakeStdout();
      const stdin = new FakeStdin();
      const errors: unknown[] = [];
      const session = await createSession({ phase: "empty" });
      const ink = render(React.createElement(App, { session }), {
        stdout: stdout as never,
        stdin: stdin as never,
        stderr: stdout as never,
        exitOnCtrlC: false,
        patchConsole: false,
        debug: false,
      });
      let exited = false;
      ink.waitUntilExit().then(
        () => (exited = true),
        (e) => {
          exited = true;
          errors.push(e);
        },
      );

      try {
        await sleep(300);
        stdin.write(`start-capture --root "${watched}" --output "${output}" --seconds 4`);
        await sleep(150);
        stdin.write("\r");

        expect(await waitFor(() => session.snapshot().phase === "live-capture", 5000)).toBe(true);

        await sleep(300);
        writeFileSync(join(watched, "live-alpha.txt"), "alpha\n");
        await sleep(300);
        appendFileSync(join(watched, "live-alpha.txt"), "more\n");
        writeFileSync(join(watched, "live-beta.log"), "beta\n");

        // Live: the new files must be on screen while still capturing.
        const sawLive = await waitFor(() => {
          const screen = stdout.recent();
          return screen.includes("live-alpha.txt") && screen.includes("live-beta.log");
        }, 2500);
        expect(session.isCapturing).toBe(true);
        expect(sawLive).toBe(true);
        expect(stdout.recent()).toContain("seed.txt");

        // Capture ends -> automatic analysis, the app stays open.
        expect(await waitFor(() => session.snapshot().phase === "analyze", 15000)).toBe(true);
        await sleep(1000);
        expect(existsSync(output)).toBe(true);
        expect(exited).toBe(false);
        expect(errors).toEqual([]);

        const screen = stdout.recent(80);
        expect(screen).toContain("capture complete");
        // Event rows are rendered with capture-relative timestamps.
        expect(/\+\d\d:\d\d\.\d{3}/.test(screen)).toBe(true);
        // Status bar shows the real capture root, not the bare `\`.
        expect(screen.replace(/\s+/g, "")).toContain(watched.replace(/\s+/g, "").slice(-20));
      } finally {
        ink.unmount();
        await session.waitForActiveCapture();
        session.close();
      }
    },
    40000,
  );
});
