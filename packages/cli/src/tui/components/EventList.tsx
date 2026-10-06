import React, { useState, useEffect, useLayoutEffect, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import type { NormalizedEvent, EventKind, SourceId, FileKey } from "../../../../core/src/index.ts";
import { Box as InkBox } from "ink";
import { eventTimestampNs, formatEventTime } from "../format.ts";

export interface EventListProps {
  /** Already filtered list. The parent owns filtering so that `EventList` and
   *  `EventDetail` agree on the index of the currently selected event. */
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
  /** Available width of the panel (already accounting for borders/padding).
   *  Used to truncate long process names so rows never overflow. */
  width?: number;
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
  width: propWidth,
}) => {
  const [scrollOffset, setScrollOffset] = useState(0);
  const visibleHeight = propVisibleHeight ?? 15;
  const [showFilterMenu, setShowFilterMenu] = useState(false);

  const totalEvents = events.length;

  // Keyboard input handler. Only active when this panel owns focus; the
  // parent app switches the global focus between prompt / files / events /
  // detail. Navigation is intentionally reduced to:
  //   ↑/↓       -> row by row
  //   Ctrl+↑/↓  -> page jump (15 rows at a time, the visible viewport size)
  //   Ctrl+Home -> first row
  //   Ctrl+End  -> last row
  //   Enter     -> open the detail panel for the highlighted row
  // Anything else (PgUp/PgDn, j/k, Home/End without Ctrl, gg/G) is left out
  // so the keymap stays predictable and short. Filter shortcuts (x, f, /)
  // are kept as plain keys because they are unrelated to navigation.
  useInput((input, key) => {
    if (!isFocused) return;

    if (showFilterMenu) {
      if (key.escape || key.return) { setShowFilterMenu(false); return; }
      if (input === "f") { onFilter({ kinds: ["Create", "Write", "Delete", "Rename", "SetInfo"] }); setShowFilterMenu(false); return; }
      if (input === "w") { onFilter({ kinds: ["Write"] }); setShowFilterMenu(false); return; }
      if (input === "c") { onFilter({ kinds: ["Create"] }); setShowFilterMenu(false); return; }
      if (input === "d") { onFilter({ kinds: ["Delete"] }); setShowFilterMenu(false); return; }
      if (input === "r") { onFilter({ kinds: ["Rename", "SetInfo"] }); setShowFilterMenu(false); return; }
      if (input === "x") { onFilter({ failedOnly: true }); setShowFilterMenu(false); return; }
      if (input === "R") { onFilter({ reset: true }); setShowFilterMenu(false); return; }
      return;
    }

    // Navigation.
    if (key.upArrow) {
      if (key.ctrl) onNavigate("pageUp");
      else onNavigate("up");
      return;
    }
    if (key.downArrow) {
      if (key.ctrl) onNavigate("pageDown");
      else onNavigate("down");
      return;
    }
    if (key.home && key.ctrl) onNavigate("first");
    if (key.end && key.ctrl) onNavigate("last");

    // Open the detail panel for the highlighted row.
    if (key.return) onSelect(selectedIndex);

    // Filter shortcuts.
    if (input === "/") { setShowFilterMenu(true); return; }
    if (input === "x") { onFilter({ failedOnly: true }); return; }
    if (input === "f") { onFilter({ reset: true }); return; }
  }, { isActive: isFocused });

  // Fixed-width columns in the row:
  //   marginLeft(1) + timestamp(10) + " │ "(3) + kind-padded(8) + " "(1)
  //   + source-padded(3) + " "(1) + "PID:" + pid(5) + " │ "(3)
  //   = 35 reserved columns. Anything beyond that is the process name budget.
  const RESERVED_COLS = 35;
  const procBudget = Math.max(4, (propWidth ?? 0) - RESERVED_COLS);
  const clipProc = (s: string) =>
    s.length <= procBudget ? s : s.slice(0, Math.max(0, procBudget - 1)) + "…";

  const filterDesc = useMemo(() => {
    const parts: string[] = [];
    if (filter?.kinds?.length) parts.push(`op=${filter.kinds.join(",")}`);
    if (filter?.failedOnly) parts.push("failed");
    if (filter?.pid) parts.push(`pid=${filter.pid}`);
    if (filter?.process) parts.push(`proc=${filter.process}`);
    return parts.join(" | ");
  }, [filter]);

  // Fixed-height rows that consume part of the panel before we get to the
  // event list: 2 rows for the round border + 1 row for the keyboard hints
  // footer (kept to exactly one row with wrap="truncate-end", rendered
  // unconditionally so the arithmetic doesn't change with focus), and 1
  // row for the filter banner when a filter is active. If this count
  // underestimates the real overhead, `visibleSlice` renders more rows
  // than Ink can paint and the selected row falls into the clipped area —
  // the "no highlight / rows missing" bug.
  const OVERHEAD_ROWS = 2 /* round border */ + 1 /* keybindings footer */;
  const effectiveVisibleHeight = Math.max(
    1,
    visibleHeight - OVERHEAD_ROWS - (filterDesc ? 1 : 0),
  );

  // Auto-scroll: keep the selected row in [scrollOffset, scrollOffset+EVH).
  //
  // CRITICAL: we compute the effective scroll position **derived from the
  // current props on every render** (so it lands on the very first frame
  // that React produces, before any useEffect runs). The earlier
  // implementation used a useEffect to call `setScrollOffset`, which left
  // a one-frame window where `selectedIndex` was outside the slice — that
  // window is exactly the "highlight disappears" bug the user reported.
  //
  // We also keep the `scrollOffset` state for cases where the user can't
  // move the selection (e.g. while a filter is being computed): in that
  // case `selectedIndex` is stale but `scrollOffset` should not jump back
  // to 0. So we derive the *target* offset, but only commit a new value
  // when it differs from the previous one and is non-decreasing.
  const safeSelected = Math.max(0, Math.min(selectedIndex, totalEvents - 1));
  const targetOffset = totalEvents === 0
    ? 0
    : (() => {
        if (safeSelected < scrollOffset) return safeSelected;
        if (safeSelected >= scrollOffset + effectiveVisibleHeight) {
          return safeSelected - effectiveVisibleHeight + 1;
        }
        return scrollOffset;
      })();
  // Commit the offset via a layout effect so the next user-driven state
  // change can rely on it; but the slice we render RIGHT NOW already uses
  // the derived `targetOffset`, so the painted frame is always consistent.
  useLayoutEffect(() => {
    if (targetOffset !== scrollOffset) setScrollOffset(targetOffset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetOffset, totalEvents, effectiveVisibleHeight]);

  const visibleSlice = useMemo(
    () => events.slice(targetOffset, targetOffset + effectiveVisibleHeight),
    [events, targetOffset, effectiveVisibleHeight],
  );

  const keyBindings = (
    <Text dimColor wrap="truncate-end">
      {" ↑/↓ rows  Ctrl+↑/↓ page  Ctrl+Home/End first/last  Enter details  / filter  x failed  f clear"}
    </Text>
  );

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
      {process.env.HARIL_DEBUG_EVENTLIST ? (
        <Text dimColor>{`[DBG targetOffset=${targetOffset} scrollOffset=${scrollOffset} selectedIndex=${selectedIndex} effectiveVisibleHeight=${effectiveVisibleHeight} totalEvents=${totalEvents}]`}</Text>
      ) : null}
      {filterDesc ? (
        <Box marginLeft={1}>
          <Text dimColor>filter: {filterDesc}</Text>
        </Box>
      ) : null}
      {loading && <Text color="yellow">  Loading...</Text>}
      {showFilterMenu && filterMenu}
      <Box flexDirection="column" flexGrow={1}>
        {visibleSlice.map((event, i) => {
          // `visibleSlice` is cut from `targetOffset`, so the absolute index
          // of row `i` is `targetOffset + i`. Using the committed
          // `scrollOffset` here would desynchronise the highlight from the
          // slice for one frame (the transient render before the layout
          // effect commits the new offset) — exactly the "highlight
          // disappears while navigating" bug.
          const absoluteIndex = targetOffset + i;
          const isSelected = absoluteIndex === selectedIndex;
          const isFocusedItem = isSelected && isFocused;

          const timestamp = formatEventTime(eventTimestampNs(event), baseNs);
          const kindColor = EVENT_KIND_COLORS[event.eventKind] || "white";
          const sourceColor = SOURCE_COLORS[event.source] || "white";

          const color = isFocusedItem ? "black" : "white";
          const backgroundColor = isFocusedItem ? (isSelected ? "cyan" : "blue") : undefined;

          const processName = event.processImageName || "?";
          const pid = event.pid > 0 ? event.pid.toString() : "?";

          return (
            <Box key={absoluteIndex} marginLeft={1} width={propWidth ? propWidth - 1 : undefined} overflow="hidden">
              <Text color={color} backgroundColor={backgroundColor} wrap="truncate-end">
                {timestamp} │{" "}
                <Text color={kindColor}>{event.eventKind.padEnd(8)}</Text>{" "}
                <Text color={sourceColor}>{event.source.toUpperCase().padEnd(3)}</Text>{" "}
                PID:{pid.padStart(5)} │{" "}
                {clipProc(processName)}
              </Text>
            </Box>
          );
        })}
        {visibleSlice.length === 0 && (
          <Box marginLeft={1}>
            <Text dimColor>
              {totalEvents === 0 ? "No events" : "No matches"}
            </Text>
          </Box>
        )}
      </Box>
      {keyBindings}
      {filterMenu}
    </InkBox>
  );
};