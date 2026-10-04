import React, { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import type { EventKind } from "@haril-ts/core";

export interface FileItem {
  fileKeyHash: string;
  display?: string;
  path?: string | null;
  kind?: "exact" | "path";
  eventCount?: number;
  attributes?: number;
}

export interface FileBrowserProps {
  entries: FileItem[];
  selectedKeyHash: string | null;
  onSelect: (entry: FileItem) => void;
  onNavigate: (direction: "left" | "right" | "first" | "last" | "up" | "down" | "pageUp" | "pageDown") => void;
  isFocused: boolean;
  filter?: { text?: string; eventKinds?: EventKind[] };
  loading: boolean;
  width?: number;
}

export const FileBrowser: React.FC<FileBrowserProps> = ({
  entries,
  selectedKeyHash,
  onSelect,
  onNavigate,
  isFocused,
  filter,
  loading,
  width = 80,
}) => {
  const [filterText, setFilterText] = useState("");
  const [filterActive, setFilterActive] = useState(false);

  const effectiveFilter = filterText || filter?.text || "";

  const filteredEntries = useMemo(() => {
    let result = entries;
    if (effectiveFilter) {
      const lower = effectiveFilter.toLowerCase();
      result = result.filter(
        (e) => (e.path || e.display || "").toLowerCase().includes(lower)
      );
    }
    return result;
  }, [entries, effectiveFilter]);

  const selectedIndex = useMemo(() => {
    if (!selectedKeyHash) return 0;
    const idx = filteredEntries.findIndex((e) => e.fileKeyHash === selectedKeyHash);
    return idx >= 0 ? idx : 0;
  }, [filteredEntries, selectedKeyHash]);

  useInput(
    (input, key) => {
      if (filterActive) {
        if (key.escape) {
          setFilterActive(false);
          setFilterText("");
          return;
        }
        if (key.return) {
          setFilterActive(false);
          return;
        }
        if (key.backspace || key.delete) {
          setFilterText((t) => t.slice(0, -1));
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          setFilterText((t) => t + input);
          return;
        }
        return;
      }

      if (key.leftArrow || input === "h") onNavigate("left");
      if (key.rightArrow || input === "l") onNavigate("right");
      if (key.upArrow || (input === "k" && (key.ctrl || key.meta))) onNavigate("left");
      if (key.downArrow || (input === "j" && (key.ctrl || key.meta))) onNavigate("right");
      if (key.home || input === "g") onNavigate("first");
      if (key.end || (input === "G" && key.shift)) onNavigate("last");
      if (key.return) {
        const entry = filteredEntries[selectedIndex];
        if (entry) {
          onSelect(entry);
        }
      }
      if (input === "/") {
        setFilterActive(true);
      }
    },
    { isActive: isFocused }
  );

  const borderColor = isFocused ? "cyan" : "gray";

  // Calculate horizontal sliding window of visible files
  const availableWidth = Math.max(20, width - 8);
  const itemsMeta = useMemo(() => {
    return filteredEntries.map((entry) => {
      const attrs = entry.attributes ?? 0;
      const isDir = (attrs & 0x10) !== 0;
      const isHidden = (attrs & 0x2) !== 0;
      const icon = isDir ? "📁 " : "📄 ";
      const rawName = entry.path
        ? entry.path.split("\\").pop() || entry.path
        : entry.display || entry.fileKeyHash.slice(0, 8);
      const eventSuffix =
        entry.eventCount !== undefined && entry.eventCount > 0
          ? ` (${entry.eventCount})`
          : "";
      const label = `${icon}${rawName}${eventSuffix}${isHidden ? " (H)" : ""}`;
      return {
        entry,
        label,
        width: label.length + 3, // label length plus separators/spacing
      };
    });
  }, [filteredEntries]);

  const visibleWindow = useMemo(() => {
    const total = itemsMeta.length;
    if (total === 0) return { start: 0, end: 0, items: [] };

    const clamped = Math.max(0, Math.min(selectedIndex, total - 1));

    const measureRange = (start: number, end: number): number => {
      let w = 0;
      if (start > 0) w += 4; // "◀ … "
      for (let i = start; i <= end; i++) {
        w += itemsMeta[i]!.width;
      }
      if (end < total - 1) w += 4; // " … ▶"
      return w;
    };

    let start = clamped;
    let end = clamped;

    // Expand to left and right while within availableWidth
    while (end + 1 < total && measureRange(start, end + 1) <= availableWidth) {
      end++;
    }
    while (start > 0 && measureRange(start - 1, end) <= availableWidth) {
      start--;
    }

    return {
      start,
      end,
      items: itemsMeta.slice(start, end + 1),
    };
  }, [itemsMeta, selectedIndex, availableWidth]);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      width="100%"
      flexShrink={0}
      paddingX={1}
    >
      {/* Top status bar */}
      <Box justifyContent="space-between">
        <Text dimColor>
          {filteredEntries.length > 0 ? `${selectedIndex + 1}/${filteredEntries.length}` : "0/0"}
          {effectiveFilter ? (
            <Text color="yellow"> [filter: {effectiveFilter}]</Text>
          ) : null}
          {loading ? <Text color="yellow"> · loading...</Text> : null}
        </Text>
        <Text dimColor>
          {isFocused ? "←/→ select · Enter load · / filter" : ""}
        </Text>
      </Box>

      {/* Horizontal file selector items */}
      <Box flexDirection="row" alignItems="center" height={1} overflow="hidden">
        {filteredEntries.length === 0 ? (
          <Text dimColor>
            {loading ? "Loading files..." : effectiveFilter ? "No matches found" : "No files observed"}
          </Text>
        ) : (
          <>
            {visibleWindow.start > 0 && (
              <Text color="cyan" bold>
                ◀ …{" "}
              </Text>
            )}
            {visibleWindow.items.map((item, idx) => {
              const absIndex = visibleWindow.start + idx;
              const isSelected = absIndex === selectedIndex;
              const isFocusedItem = isSelected && isFocused;

              return (
                <Box key={item.entry.fileKeyHash || String(absIndex)} flexDirection="row">
                  {idx > 0 && <Text dimColor> │ </Text>}
                  <Text
                    color={isFocusedItem ? "black" : isSelected ? "cyan" : "white"}
                    backgroundColor={isFocusedItem ? "cyan" : isSelected ? "blue" : undefined}
                    bold={isSelected}
                  >
                    {isSelected ? `[${item.label}]` : ` ${item.label} `}
                  </Text>
                </Box>
              );
            })}
            {visibleWindow.end < filteredEntries.length - 1 && (
              <Text color="cyan" bold>
                {" "}
                … ▶
              </Text>
            )}
          </>
        )}
      </Box>
    </Box>
  );
};