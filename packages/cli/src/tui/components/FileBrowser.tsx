import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput, useFocus } from "ink";
import type { FileKey, InventoryEntry, EventKind, SourceId } from "@haril-ts/core";
import { Box as InkBox } from "ink";

export interface FileBrowserProps {
  entries: InventoryEntry[];
  selectedKey: FileKey | null;
  onSelect: (key: FileKey) => void;
  onNavigate: (direction: "up" | "down" | "first" | "last" | "pageUp" | "pageDown") => void;
  isFocused: boolean;
  filter?: { text?: string; eventKinds?: EventKind[] };
  loading: boolean;
}

export const FileBrowser: React.FC<FileBrowserProps> = ({
  entries,
  selectedKey,
  onSelect,
  onNavigate,
  isFocused,
  filter,
  loading,
}) => {
  const [scrollOffset, setScrollOffset] = useState(0);
  const visibleHeight = useMemo(() => 20, []); // approximate visible items

  const filteredEntries = useMemo(() => {
    let result = entries;
    if (filter?.text) {
      const lower = filter.text.toLowerCase();
      result = result.filter(e => e.path.toLowerCase().includes(lower));
    }
    return result;
  }, [entries, filter?.text]);

  const selectedIndex = useMemo(() => {
    if (!selectedKey) return -1;
    return filteredEntries.findIndex(e => {
      if (selectedKey.kind === "exact") {
        return e.fileId128 && e.volumeSerial === selectedKey.volumeSerial &&
               e.fileId128.every((b, i) => b === selectedKey.fileId128[i]);
      }
      return e.path === selectedKey.path;
    });
  }, [filteredEntries, selectedKey]);

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
    if (key.upArrow || key.k && (key.ctrl || key.meta)) onNavigate("up");
    if (key.downArrow || key.j && (key.ctrl || key.meta)) onNavigate("down");
    if (key.home || (key.g && key.g)) onNavigate("first");
    if (key.end || (key.G && key.shift)) onNavigate("last");
    if (key.pageUp) onNavigate("pageUp");
    if (key.pageDown) onNavigate("pageDown");
    if (key.return) {
      const entry = filteredEntries[selectedIndex];
      if (entry) {
        const key: FileKey = entry.fileId128 && entry.volumeSerial
          ? { kind: "exact", volumeSerial: entry.volumeSerial, fileId128: entry.fileId128 }
          : { kind: "path", root: "", path: entry.path };
        onSelect(key);
      }
    }
    if (key.f && key.ctrl) {
      // toggle filter
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
          
          const attrs = entry.attributes;
          const isDir = (attrs & 0x10) !== 0;
          const isHidden = (attrs & 0x2) !== 0;
          
          const icon = isDir ? "📁 " : "📄 ";
          const name = entry.path.split("\\").pop() || entry.path;
          
          const color = isFocusedItem ? (isSelected ? "black" : "white") : "white";
          const backgroundColor = isFocusedItem ? (isSelected ? "cyan" : "blue") : undefined;
          
          return (
            <Box key={entry.path} marginLeft={1}>
              <Text color={color} backgroundColor={backgroundColor}>
                {icon}{name}
                {isHidden && <Text dimColor> (hidden)</Text>}
              </Text>
            </Box>
          );
        })}
        {visibleEntries.length === 0 && (
          <Text dimColor marginLeft={1}>
            {filter?.text ? "No matches" : "No files"}
          </Text>
        )}
      </Box>
      {keyBindings}
    </InkBox>
  );
};