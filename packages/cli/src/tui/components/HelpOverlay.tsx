import React from "react";
import { Box, Text } from "ink";
import { KEYBOARD_HELP } from "../keys.ts";

export const HelpOverlay: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="green">
      <Text color="green">{`Haril — keyboard help\n\n${KEYBOARD_HELP}\n\nType 'help' in the prompt for the command list.`}</Text>
      <Text dimColor>[Esc] closes</Text>
    </Box>
  );
};