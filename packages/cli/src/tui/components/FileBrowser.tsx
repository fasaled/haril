import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import type { EventKind } from "@haril-ts/core";
import { Box as InkBox } from "ink";

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
  onNavigate: (direction: "up" | "down" | "first" | "last" | "pageUp" | "pageDown") => void;
  isFocused: boolean;
  filter?: { text?: string; eventKinds?: EventKind[] };
  loading: boolean;
}

export const FileBrowser: React.FC<FileBrowserProps> = ({
  entries,
  selectedKeyHash,
  onSelect,
  onNavigate,
  isFocused,
  filter,
  loading,
}) => {
  const [scrollOffset, setScrollOffset] = useState(0);
  const visibleHeight = useMemo(() => 20, []);

  const filteredEntries = useMemo(() => {
    let result = entries;
    if (filter?.text) {
      const lower = filter.text.toLowerCase();
      result = result.filter(e => (e.path || e.display || "").toLowerCase().includes(lower));
    }
    return result;
  }, [entries, filter?.text]);

  const selectedIndex = useMemo(() => {
    if (!selectedKeyHash) return -1;
    return filteredEntries.findIndex(e => e.fileKeyHash === selectedKeyHash);
  }, [filteredEntries, selectedKeyHash]);

  // Auto-scroll to keep selected item visible
  useEffect(() => {
    if (selectedIndex >= 0) {
      if (selectedIndex < scrollOffset) {
        setScrollOffset(selectedIndex);
      } else if (selectedIndex >= scrollOffset + visibleHeight) {
        setScrollOffset(selectedIndex - visibleHeight + 1);
      }
    }
  }, [selectedIndex, visibleHeight]);

  const handleInput = (input: string, key: any) => {
    if (key.upArrow || (key.k && (key.ctrl || key.meta))) onNavigate("up");
    if (key.downArrow || (key.j && (key.ctrl || key.meta))) onNavigate("down");
    if (key.home || (key.g && key.g)) onNavigate("first");
    if (key.end || (key.G && key.shift)) onNavigate("last");
    if (key.pageUp) onNavigate("pageUp");
    if (key.pageDown) onNavigate("pageDown");
    if (key.return) {
      const entry = filteredEntries[selectedIndex];
      if (entry) {
        onSelect(entry);
      }
    }
  };

  useInput(handleInput, { isActive: isFocused });

  const keyBindings = isFocused ? (
    <Text dimColor>
      {" ↑/k ↓/j  Home/gg  End/G  PgUp/PgDn  Enter/select  Esc/unfocus  / filter"}
    </Text>
  ) : null;

  const borderColor = isFocused ? "cyan" : "gray";
  const title = isFocused ? " FILES (focused) " : " FILES ";

  const visibleEntries = filteredEntries.slice(scrollOffset, scrollOffset + visibleHeight);

  return (
    <InkBox flexDirection="column" borderStyle="round" borderColor={borderColor} width="100%" height="100%">
      <Box>
        <Text backgroundColor={isFocused ? "cyan" : "gray"} color="white">
          {title}
        </Text>
      </Box>
      {loading && <Text color="yellow">  Loading...</Text>}
      <Box flexDirection="column" flexGrow={1}>
        {visibleEntries.map((entry, i) => {
          const absoluteIndex = scrollOffset + i;
          const isSelected = absoluteIndex === selectedIndex;
          const isFocusedItem = isSelected && isFocused;

          const attrs = entry.attributes ?? 0;
          const isDir = (attrs & 0x10) !== 0;
          const isHidden = (attrs & 0x2) !== 0;

          const icon = isDir ? "📁 " : "📄 ";
          const name = entry.path ? (entry.path.split("\\").pop() || entry.path) : (entry.display || entry.fileKeyHash);
          const eventSuffix = entry.eventCount !== undefined && entry.eventCount > 0 ? ` (${entry.eventCount})` : "";

          const color = isFocusedItem ? (isSelected ? "black" : "white") : "white";
          const backgroundColor = isFocusedItem ? (isSelected ? "cyan" : "blue") : undefined;

          return (
            <Box key={entry.fileKeyHash || String(i)} marginLeft={1}>
              <Text color={color} backgroundColor={backgroundColor}>
                {icon}{name}{eventSuffix}
                {isHidden && <Text dimColor> (hidden)</Text>}
              </Text>
            </Box>
          );
        })}
        {visibleEntries.length === 0 && (
          <Box marginLeft={1}>
            <Text dimColor>
              {filter?.text ? "No matches" : "No files"}
            </Text>
          </Box>
        )}
      </Box>
      {keyBindings}
    </InkBox>
  );
};