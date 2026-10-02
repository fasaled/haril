import React from "react";
import { Box, Text } from "ink";

const HELP = `Haril — keyboard help

  :                       focus prompt
  \\                       mini-input for cd
  s                       summary of selected file
  c                       capture manifest in activity
  v                       toggle heuristics
  h                       reopen last activity entry
  ?                       open this help
  n / N                   page file lanes
  o / f / p / e / r       filters for events (op, failed, process, pid, reset)
  Ctrl+Q                  exit TUI

Phases
  Empty     open <path.haril> | start-capture ...
  Live      stop-capture | force-quit-capture
  Analyze   ls / cd / events / evidence / summary / search / overview / dirs / size-changes`;

export const HelpOverlay: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="green">
      <Text color="green">{HELP}</Text>
      <Text dimColor>[Esc] closes</Text>
    </Box>
  );
};