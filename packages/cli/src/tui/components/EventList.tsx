import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import type { NormalizedEvent, EventKind, SourceId, FileKey } from "@haril-ts/core";
import { Box as InkBox } from "ink";
import { eventTimestampNs, formatEventTime } from "../format.ts";

export interface EventListProps {
  events: NormalizedEvent[];
  /** Capture start (QPC ns); timestamps are shown relative to it. */
  baseNs?: unknown;
  fileKey: FileKey | null;
  selectedIndex: number;
  onSelect: (index: number) => void;
  onNavigate: (direction: "up" | "down" | "first" | "last" | "pageUp" | "pageDown") => void;
  onFilter: (filter: { kinds?: EventKind[]; failedOnly?: boolean; pid?: number; process?: string; reset?: boolean }) => void;
  isFocused: boolean;
  filter?: { kinds?: EventKind[]; failedOnly?: boolean; pid?: number; process?: string };
  loading: boolean;
  visibleHeight?: number;
}

const EVENT_KIND_COLORS: Record<EventKind, string> = {
  Create: "green",
  Open: "blue",
  Read: "cyan",
  Write: "yellow",
  SetInfo: "magenta",
  Rename: "magenta",
  Delete: "red",
  Close: "gray",
  OpEnd: "gray",
  Notify: "white",
};

const SOURCE_COLORS: Record<SourceId, string> = {
  etw: "green",
  usn: "yellow",
  fsw: "blue",
};

export const EventList: React.FC<EventListProps> = ({
  events,
  baseNs,
  fileKey,
  selectedIndex,
  onSelect,
  onNavigate,
  onFilter,
  isFocused,
  filter,
  loading,
  visibleHeight: propVisibleHeight,
}) => {
  const [scrollOffset, setScrollOffset] = useState(0);
  const visibleHeight = propVisibleHeight ?? 15;
  const [showFilterMenu, setShowFilterMenu] = useState(false);

  const filteredEvents = useMemo(() => {
    let result = events;
    if (filter?.kinds?.length) {
      result = result.filter(e => filter.kinds!.includes(e.eventKind));
    }
    if (filter?.failedOnly) {
      result = result.filter(e => e.ntStatus !== null && e.ntStatus !== 0);
    }
    if (filter?.pid != null) {
      result = result.filter(e => e.pid === filter.pid);
    }
    if (filter?.process) {
      const lower = filter.process.toLowerCase();
      result = result.filter(e => e.processImageName?.toLowerCase().includes(lower));
    }
    return result;
  }, [events, filter]);

  // Auto-scroll to keep selected item visible
  useEffect(() => {
    if (selectedIndex >= 0 && selectedIndex < filteredEvents.length) {
      if (selectedIndex < scrollOffset) {
        setScrollOffset(selectedIndex);
      } else if (selectedIndex >= scrollOffset + visibleHeight) {
        setScrollOffset(selectedIndex - visibleHeight + 1);
      }
    }
  }, [selectedIndex, filteredEvents.length, visibleHeight]);

  const handleInput = (input: string, key: any) => {
    if (showFilterMenu) {
      if (key.escape) { setShowFilterMenu(false); return; }
      if (key.return) { setShowFilterMenu(false); return; }
      if (key.f) { onFilter({ kinds: ["Create", "Write", "Delete", "Rename", "SetInfo"] }); setShowFilterMenu(false); return; }
      if (key.w) { onFilter({ kinds: ["Write"] }); setShowFilterMenu(false); return; }
      if (key.c) { onFilter({ kinds: ["Create"] }); setShowFilterMenu(false); return; }
      if (key.d) { onFilter({ kinds: ["Delete"] }); setShowFilterMenu(false); return; }
      if (key.r) { onFilter({ kinds: ["Rename", "SetInfo"] }); setShowFilterMenu(false); return; }
      if (key.x) { onFilter({ failedOnly: true }); setShowFilterMenu(false); return; }
      if (key.r && key.shift) { onFilter({ reset: true }); setShowFilterMenu(false); return; }
      return;
    }

    if (key.upArrow || key.k && (key.ctrl || key.meta)) onNavigate("up");
    if (key.downArrow || key.j && (key.ctrl || key.meta)) onNavigate("down");
    if (key.home || (key.g && key.g)) onNavigate("first");
    if (key.end || (key.G && key.shift)) onNavigate("last");
    if (key.pageUp) onNavigate("pageUp");
    if (key.pageDown) onNavigate("pageDown");
    if (key.return) onSelect(selectedIndex);
    if (input === "/") { setShowFilterMenu(true); return; }
    if (input === "f") { onFilter({ kinds: [] }); return; }
    if (input === "x") { onFilter({ failedOnly: true }); return; }
    if (input === "r") { onFilter({ reset: true }); return; }
    if (input === "s") {
      // summary
      return;
    }
    if (input === "e") {
      // evidence
      return;
    }
  };

  useInput(handleInput, { isActive: isFocused });

  // Auto-scroll
  useEffect(() => {
    if (selectedIndex >= 0) {
      if (selectedIndex < scrollOffset) {
        setScrollOffset(selectedIndex);
      } else if (selectedIndex >= scrollOffset + visibleHeight) {
        setScrollOffset(selectedIndex - visibleHeight + 1);
      }
    }
  }, [selectedIndex, visibleHeight]);

  const visibleEvents = filteredEvents.slice(scrollOffset, scrollOffset + visibleHeight);

  const filterDesc = useMemo(() => {
    const parts: string[] = [];
    if (filter?.kinds?.length) parts.push(`op=${filter.kinds.join(",")}`);
    if (filter?.failedOnly) parts.push("failed");
    if (filter?.pid) parts.push(`pid=${filter.pid}`);
    if (filter?.process) parts.push(`proc=${filter.process}`);
    return parts.join(" | ");
  }, [filter]);

  const keyBindings = isFocused ? (
    <Text dimColor>
      {" ↑/k ↓/j  Home/gg  End/G  PgUp/PgDn  Enter/details  /filter  f/clear  x/failed  r/reset  s/summary  e/evidence"}
    </Text>
  ) : null;

  const filterMenu = showFilterMenu ? (
    <InkBox flexDirection="column" borderStyle="single" borderColor="yellow" marginLeft={2} marginTop={1}>
      <Text color="yellow"> Filter Menu (press key) </Text>
      <Text dimColor>  f: file ops (Create/Write/Delete/Rename/SetInfo) </Text>
      <Text dimColor>  w: writes only </Text>
      <Text dimColor>  c: creates only </Text>
      <Text dimColor>  d: deletes only </Text>
      <Text dimColor>  r: renames/setinfo </Text>
      <Text dimColor>  x: failed only </Text>
      <Text dimColor>  R: reset all </Text>
      <Text dimColor>  Esc: close </Text>
    </InkBox>
  ) : null;

  const borderColor = isFocused ? "cyan" : "gray";

  return (
    <InkBox flexDirection="column" borderStyle="round" borderColor={borderColor} width="100%" height="100%">
      {filterDesc ? (
        <Box marginLeft={1}>
          <Text dimColor>filter: {filterDesc}</Text>
        </Box>
      ) : null}
      {loading && <Text color="yellow">  Loading...</Text>}
      {showFilterMenu && filterMenu}
      <Box flexDirection="column" flexGrow={1}>
        {visibleEvents.map((event, i) => {
          const absoluteIndex = scrollOffset + i;
          const isSelected = absoluteIndex === selectedIndex;
          const isFocusedItem = isSelected && isFocused;
          
          const timestamp = formatEventTime(eventTimestampNs(event), baseNs);
          const kindColor = EVENT_KIND_COLORS[event.eventKind] || "white";
          const sourceColor = SOURCE_COLORS[event.source] || "white";
          
          const color = isFocusedItem ? "black" : "white";
          const backgroundColor = isFocusedItem ? (isSelected ? "cyan" : "blue") : undefined;
          
          const processName = event.processImageName || "?";
          const pid = event.pid !== undefined ? event.pid.toString() : "?";
          
          return (
            <Box key={absoluteIndex} marginLeft={1}>
              <Text color={color} backgroundColor={backgroundColor}>
                {timestamp} │{" "}
                <Text color={kindColor}>{event.eventKind.padEnd(8)}</Text>{" "}
                <Text color={sourceColor}>{event.source.toUpperCase().padEnd(3)}</Text>{" "}
                PID:{pid.padStart(5)} │{" "}
                {processName}
              </Text>
            </Box>
          );
        })}
        {visibleEvents.length === 0 && (
          <Box marginLeft={1}>
            <Text dimColor>
              {filteredEvents.length === 0 ? "No events" : "No matches"}
            </Text>
          </Box>
        )}
      </Box>
      {keyBindings}
      {filterMenu}
    </InkBox>
  );
};