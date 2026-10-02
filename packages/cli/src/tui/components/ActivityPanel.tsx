import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export interface ActivityEntry {
  id: number;
  command: string;
  ok: boolean;
  text: string;
}

export interface ActivityPanelProps {
  entries: ActivityEntry[];
  open: boolean;
  onToggle: () => void;
}

export const ActivityPanel: React.FC<ActivityPanelProps> = ({ entries, open, onToggle }) => {
  useInput((input, key) => {
    if (key.escape) onToggle();
  });

  if (!open || entries.length === 0) {
    if (entries.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>[h] help · [?] help · activity panel empty</Text>
        </Box>
      );
    }
    return null;
  }

  const last = entries[entries.length - 1]!;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray">
      <Text dimColor>
        ── activity ───────────────────────────────────────────── [Esc collapse]
      </Text>
      <Text>$ {last.command}</Text>
      <Text color={last.ok ? "white" : "red"}>{last.text}</Text>
    </Box>
  );
};