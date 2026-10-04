#!/usr/bin/env bun
/**
 * CLI entry point: routes between TUI, MCP server, and shell completion.
 *
 *   haril                                  → TUI (default; phase Empty)
 *   haril --resume-pending                 → TUI reading pending-session.json
 *   haril mcp [path.haril]                 → MCP stdio server
 *   haril mcp --events <journal.jsonl>     → MCP server with journal
 *   haril completion <shell>               → shell completion script
 *   haril help
 *   haril --version
 */

import { render } from "ink";
import React from "react";
import { App } from "./tui/App.tsx";
import { KEYBOARD_HELP } from "./tui/keys.ts";
import { serveMcp } from "./mcp/serve.ts";
import { runCompletion } from "./completion.ts";
import { HarilSession, createSession } from "@haril-ts/core";
import { resumePendingSession } from "./resume.ts";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    await runTui();
    return;
  }

  const first = args[0]!;

  switch (first) {
    case "--version":
    case "-v":
      console.log(`haril ${VERSION}`);
      return;

    case "--help":
    case "help":
      printHelp();
      return;

    case "mcp":
      await runMcp(args.slice(1));
      return;

    case "completion":
      runCompletion(args[1] ?? "");
      return;

    case "--resume-pending":
      await runResumePending();
      return;

    default:
      // Unrecognized argument
      console.error(`unknown argument: ${first}`);
      printHelp();
      process.exit(2);
  }
}

async function runTui(): Promise<void> {
  const session = await createSession({ phase: "empty" });
  const ink = render(React.createElement(App, { session }), {
    alternateScreen: true,
    exitOnCtrlC: false,
  });
  await ink.waitUntilExit();
  session.close();
}

async function runResumePending(): Promise<void> {
  const session = await createSession();
  const ok = resumePendingSession(session);
  if (!ok) {
    console.error("pending-session.json is missing or invalid; nothing to resume");
    process.exit(1);
  }
  const ink = render(React.createElement(App, { session }), {
    alternateScreen: true,
    exitOnCtrlC: false,
  });
  await ink.waitUntilExit();
  session.close();
}

async function runMcp(args: string[]): Promise<void> {
  // Parse flags first, then the optional package path.
  let journalPath: string | null = null;
  let packagePath: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--events") {
      journalPath = args[++i] ?? null;
    } else if (!a.startsWith("--")) {
      packagePath = a;
    }
  }
  await serveMcp({ packagePath, journalPath });
}

function printHelp(): void {
  console.log(`haril ${VERSION}

USAGE
  haril                                Interactive TUI
  haril --resume-pending               Resume a pending live capture
  haril mcp [path.haril] [--events <journal>]
                                        MCP server over stdio
  haril completion <bash|zsh|fish|powershell>
                                        Print shell completion script
  haril help
  haril --version

Inside the TUI:
  Empty phase:
    ls [dir] [--pattern <glob>], cd <dir>, pwd   (filesystem)
    open <path.haril>
    start-capture [--root <dir>] [--output <file.haril>] [--seconds <n>]
      (defaults: root = working directory, output = haril-YYYYMMDD-HHMMSS.haril
       in the working directory, 30 seconds)

  Live Capture phase:
    stop-capture
    force-quit-capture

  Analyze phase:
    ls [path] [--pattern <glob>] [--identity exact|path-scoped]
    cd <dir>, pwd, close
    events, evidence, overview, summary, dirs, size-changes, search
    capture, heuristics [on|off], zoom

  Keyboard:
${KEYBOARD_HELP.replace(/^/gm, "    ")}

Project: see README.md and docs/`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});