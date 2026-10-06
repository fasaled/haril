import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { LiveCaptureState, LiveEvent } from "../../../../core/src/index.ts";
import { formatOffsetNs } from "../format.ts";

export interface LiveCapturePanelProps {
  live: LiveCaptureState | null;
  /** Root-relative path to filter the stream by; null shows every event. */
  selectedPath: string | null;
  isFocused: boolean;
  /** Lines scrolled up from the tail; 0 follows new events. */
  scrollOffset: number;
  height: number;
  /** Available width inside the panel (accounting for borders/padding). */
  width?: number;
}

const KIND_COLORS: Record<string, string> = {
  Create: "green",
  create: "green",
  Open: "blue",
  Read: "cyan",
  Write: "yellow",
  modify: "yellow",
  SetInfo: "magenta",
  Rename: "magenta",
  rename: "magenta",
  Delete: "red",
  delete: "red",
  Close: "gray",
  OpEnd: "gray",
  Notify: "white",
};

const SOURCE_COLORS: Record<string, string> = { etw: "green", usn: "yellow", fsw: "blue" };

export function filterLiveEvents(events: readonly LiveEvent[], selectedPath: string | null): LiveEvent[] {
  if (!selectedPath) return events as LiveEvent[];
  const lower = selectedPath.toLowerCase();
  return events.filter((e) => e.path?.toLowerCase() === lower);
}

export const LiveCapturePanel: React.FC<LiveCapturePanelProps> = ({
  live,
  selectedPath,
  isFocused,
  scrollOffset,
  height,
  width: propWidth,
}) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!live) {
    return (
      <Box borderStyle="round" borderColor="gray" width="100%" height="100%" paddingX={1}>
        <Text dimColor>Starting capture…</Text>
      </Box>
    );
  }

  const elapsedS = Math.max(0, Math.floor((now - live.startedAt) / 1000));
  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  const src = live.sources;
  const srcLabel = (name: "etw" | "usn", on: boolean | undefined, rc: number | undefined) =>
    src === null ? (
      <Text dimColor>{name.toUpperCase()} …</Text>
    ) : on ? (
      <Text color={SOURCE_COLORS[name]}>
        {name.toUpperCase()} {live.counts[name].toLocaleString()}
      </Text>
    ) : (
      <Text color="gray">
        {name.toUpperCase()} off{rc ? ` (rc=${rc})` : ""}
      </Text>
    );

  const filtered = filterLiveEvents(live.events, selectedPath);
  // Header line + border (2) take 3 rows.
  const visible = Math.max(1, height - 3);
  const maxOffset = Math.max(0, filtered.length - visible);
  const offset = Math.min(scrollOffset, maxOffset);
  const end = filtered.length - offset;
  const rows = filtered.slice(Math.max(0, end - visible), end);

  // Fixed columns per row: offset(10) + " "(1) + kind-pad(8) + " "(1) +
  // source-upper + " "(1) + pid-pad(6) + " "(1) + paddingX(2) = ~30 cols.
  // Reserve that and split the rest between path and process name.
  const innerWidth = propWidth ? Math.max(10, propWidth - 2) : 0; // minus paddingX
  const RESERVED = 10 + 1 + 8 + 1 + 3 + 1 + 6 + 1; // 31
  const restCols = Math.max(0, innerWidth - RESERVED);
  // Heuristic: most events have no process name, so when present allocate
  // a fair share; when absent give all to the path.
  const splitCols = (proc: string | undefined | null): { pathCols: number; procCols: number } => {
    if (!proc) return { pathCols: restCols, procCols: 0 };
    const procCols = Math.min(proc.length + 1, Math.floor(restCols / 2));
    const pathCols = Math.max(0, restCols - procCols - 2); // "  " separator
    return { pathCols, procCols };
  };
  const clip = (s: string, n: number) =>
    !n || s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "…";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={isFocused ? "cyan" : "green"}
      width="100%"
      height="100%"
      paddingX={1}
      overflow="hidden"
    >
      <Box justifyContent="space-between" flexShrink={0}>
        <Text>
          <Text color="yellow">
            ⏱ {fmt(elapsedS)} / {fmt(live.seconds)}
          </Text>
          <Text dimColor>  ·  </Text>
          {srcLabel("etw", src?.etw, src?.etwRc)}
          <Text dimColor>  ·  </Text>
          {srcLabel("usn", src?.usn, src?.usnRc)}
          <Text dimColor>  ·  </Text>
          <Text color={SOURCE_COLORS.fsw}>FSW {live.counts.fsw.toLocaleString()}</Text>
          <Text dimColor>  ·  events {live.totalEvents.toLocaleString()}  ·  files {live.files.length}</Text>
        </Text>
        <Text dimColor>
          {selectedPath ? `${selectedPath} · ` : ""}
          {offset > 0 ? `↑${offset} (End follows)` : "following"}
        </Text>
      </Box>
      {rows.length === 0 ? (
        <Text dimColor wrap="truncate-end">
          {selectedPath ? "No events for this file yet" : "Waiting for file activity under "}
          {selectedPath ? "" : live.root}
        </Text>
      ) : (
        rows.map((e) => {
          const { pathCols, procCols } = splitCols(e.process);
          return (
            <Box key={e.seq} width="100%" overflow="hidden">
              <Text wrap="truncate-end">
                <Text dimColor>{formatOffsetNs(e.offsetNs)} </Text>
                <Text color={KIND_COLORS[e.kind] ?? "white"}>{e.kind.padEnd(8)}</Text>{" "}
                <Text color={SOURCE_COLORS[e.source] ?? "white"}>{e.source.toUpperCase()}</Text>{" "}
                <Text dimColor>{e.pid != null && e.pid > 0 ? String(e.pid).padStart(6) : "     -"} </Text>
                <Text>{clip(e.path ?? "?", pathCols)}</Text>
                {e.process ? <Text dimColor>  {clip(e.process, procCols)}</Text> : null}
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
};
