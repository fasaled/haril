/**
 * TUI root component. Wires the panels and the command prompt.
 *
 * Renders inside Ink's alternate screen. Phase-dependent layout:
 *
 *   Empty       → header + activity panel + prompt
 *   Analyze     → header + activity panel + prompt
 *   LiveCapture → header + activity panel + prompt
 */

import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { HarilSession, SessionSnapshot } from "@haril-ts/core";
import { Header } from "./components/Header.tsx";
import { Prompt } from "./components/Prompt.tsx";
import { ActivityPanel } from "./components/ActivityPanel.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { HelpOverlay } from "./components/HelpOverlay.tsx";

export interface ActivityEntry {
  id: number;
  command: string;
  ok: boolean;
  text: string;
}

export interface AppProps {
  session: HarilSession;
}

export const App: React.FC<AppProps> = ({ session }) => {
  const { exit } = useApp();
  const [snap, setSnap] = useState<SessionSnapshot>(() => session.snapshot());
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [activityOpen, setActivityOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const nextId = useMemo(() => ({ v: 1 }), []);
  const [lastExit, setLastExit] = useState(false);

  useEffect(() => {
    setSnap(session.snapshot());
  }, []);

  useInput((input, key) => {
    if (key.ctrl && input === "q") {
      setLastExit(true);
      exit();
      return;
    }
    if (input === "?") {
      setHelpOpen((v) => !v);
      return;
    }
  });

  const onPromptSubmit = async (line: string) => {
    if (!line.trim()) return;
    const id = nextId.v++;
    const placeholder: ActivityEntry = {
      id,
      command: line,
      ok: true,
      text: "$ " + line,
    };
    setActivity((cur) => [...cur, placeholder]);
    setActivityOpen(true);

    const result = await session.run(line);
    const text = formatResult(result);
    setActivity((cur) => cur.map((e) => (e.id === id ? { ...e, ok: result.ok, text: text } : e)));

    if ((result.data as any)?.action === "quit") {
      setLastExit(true);
      exit();
      return;
    }
    setSnap(session.snapshot());
  };

  const hint = useMemo(() => {
    if (snap.phase === "empty") return "open <path.haril> | start-capture [--root <dir>] [--output <file.haril>] [--seconds <n>]";
    if (snap.phase === "live-capture") return "▶ live-capture — stop-capture | force-quit-capture";
    return `▶ package: ${snap.packagePath ?? "?"} — close`;
  }, [snap]);

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <Header snapshot={snap} />
      <StatusBar snapshot={snap} />
      <ActivityPanel entries={activity} open={activityOpen} onToggle={() => setActivityOpen((v) => !v)} />
      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
      <Prompt
        hint={hint}
        history={session.history() as string[]}
        onSubmit={onPromptSubmit}
        phase={snap.phase}
      />
    </Box>
  );
};

function formatResult(res: { ok: boolean; error?: string; data?: unknown; kind: string }): string {
  if (!res.ok) return (res.error ?? "command failed");
  if (res.kind === "none") return "(ok)";
  if (res.kind === "json") {
    try {
      return JSON.stringify(res.data, null, 2);
    } catch {
      return String(res.data);
    }
  }
  if (typeof res.data === "string") return res.data;
  return JSON.stringify(res.data ?? null, null, 2);
}