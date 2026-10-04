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
        <Text dimColor>
          {selectedPath ? "No events for this file yet" : "Waiting for file activity under "}
          {selectedPath ? "" : live.root}
        </Text>
      ) : (
        rows.map((e) => (
          <Text key={e.seq} wrap="truncate-end">
            <Text dimColor>{formatOffsetNs(e.offsetNs)} </Text>
            <Text color={KIND_COLORS[e.kind] ?? "white"}>{e.kind.padEnd(8)}</Text>{" "}
            <Text color={SOURCE_COLORS[e.source] ?? "white"}>{e.source.toUpperCase()}</Text>{" "}
            <Text dimColor>{e.pid != null && e.pid > 0 ? String(e.pid).padStart(6) : "     -"} </Text>
            <Text>{e.path ?? "?"}</Text>
            {e.process ? <Text dimColor>  {e.process}</Text> : null}
          </Text>
        ))
      )}
    </Box>
  );
};
