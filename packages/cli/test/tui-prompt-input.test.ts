/**
 * Regression test for the "Ctrl combo leaks a letter into the prompt" bug.
 *
 * The prompt previously used ink-text-input, whose useInput only ignored
 * Ctrl+C/arrows/Tab — every other Ctrl combo (Ctrl+E/D/F panel switches,
 * which App handles globally) fell through to the "insert character" path
 * and printed a stray letter into the prompt input when the prompt was the
 * focus origin.
 *
 * The prompt now owns its input handling and ignores all Ctrl/Meta combos.
 * These tests drive the real Prompt through Ink and assert what is typed.
 */

import { describe, test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { createSession } from "@haril-ts/core";
import { Prompt } from "../src/tui/components/Prompt.tsx";

class CaptureStdout extends PassThrough {
  columns = 120;
  rows = 45;
  isTTY = true;
  chunks: string[] = [];
  override write(chunk: unknown, ...rest: unknown[]): boolean {
    this.chunks.push(String(chunk));
    return super.write(chunk as string, ...(rest as []));
  }
  lastBox(): string {
    const text = this.chunks
      .join("")
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b\][^\x07]*\x07/g, "");
    const boxes = text.split("╭");
    const last = boxes[boxes.length - 1] ?? "";
    const end = last.indexOf("╯");
    return end >= 0 ? last.slice(0, end) : last;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function makePrompt(opts?: { focused?: boolean }) {
  const session = await createSession({ phase: "empty" });
  const stdout = new CaptureStdout();
  const stdin = makeStdin();
  const submitted: string[] = [];

  const inst = render(
    React.createElement(Prompt, {
      hint: "",
      history: [],
      phase: session.snapshot().phase,
      session,
      onSubmit: (line) => {
        submitted.push(line);
      },
      isFocused: opts?.focused ?? true,
      width: 100,
      height: 10,
    }),
    { stdout: stdout as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false },
  );
  await sleep(60);

  const press = async (seq: string, ms = 40) => {
    stdin.write(seq);
    await sleep(ms);
  };

  return { inst, stdout, stdin, submitted, press, session };
}

describe("Prompt input handling", () => {
  test("Ctrl+E (panel switch) does not type an 'e' into the prompt", async () => {
    const { inst, stdout, press } = await makePrompt();
    await press("\u0005"); // Ctrl+E
    const box = stdout.lastBox();
    expect(box).toContain("❯");
    // No letter may have been typed into the input line.
    expect(box).not.toMatch(/❯\s*e/);
    inst.unmount();
  });

  test("Ctrl+D and Ctrl+F are also ignored by the prompt", async () => {
    const { inst, stdout, press } = await makePrompt();
    await press("\u0004"); // Ctrl+D
    await press("\u0006"); // Ctrl+F
    const box = stdout.lastBox();
    expect(box).not.toMatch(/❯\s*[df]/);
    inst.unmount();
  });

  test("plain typing still works", async () => {
    const { inst, stdout, press } = await makePrompt();
    await press("l");
    await press("s");
    const box = stdout.lastBox();
    expect(box).toContain("❯ l");
    inst.unmount();
  });

  test("backspace removes the last character", async () => {
    const { inst, stdout, press } = await makePrompt();
    await press("l");
    await press("s");
    await press("\u007f"); // backspace (DEL)
    const box = stdout.lastBox();
    expect(box).toContain("❯ l");
    expect(box).not.toContain("❯ ls");
    inst.unmount();
  });

  test("Ctrl combo mid-typing does not alter the typed text", async () => {
    const { inst, stdout, press } = await makePrompt();
    await press("l");
    await press("\u0005"); // Ctrl+E mid-line
    const box = stdout.lastBox();
    expect(box).toContain("❯ l");
    expect(box).not.toContain("le");
    inst.unmount();
  });

  test("Enter submits the typed line", async () => {
    const { inst, submitted, press } = await makePrompt();
    await press("h");
    await press("e");
    await press("l");
    await press("p");
    await press("\r");
    expect(submitted).toEqual(["help"]);
    inst.unmount();
  });

  test("typing is ignored when the prompt is not focused", async () => {
    const { inst, stdout, press } = await makePrompt({ focused: false });
    await press("l");
    await press("s");
    const box = stdout.lastBox();
    expect(box).not.toContain("ls");
    inst.unmount();
  });

  test("arrows move the cursor instead of typing", async () => {
    const { inst, stdout, press } = await makePrompt();
    await press("a");
    await press("b");
    await press("\u001b[D"); // left arrow
    await press("x");
    // Inserted before 'b': "axb"
    const box = stdout.lastBox();
    expect(box).toContain("axb");
    inst.unmount();
  });
});
