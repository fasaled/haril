import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import type { Phase } from "@haril-ts/core";

export interface PromptProps {
  hint: string;
  history: readonly string[];
  phase: Phase;
  onSubmit: (line: string) => void | Promise<void>;
}

export const Prompt: React.FC<PromptProps> = ({ hint, history, onSubmit }) => {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan">
      <Box>
        <Text dimColor>{hint}</Text>
      </Box>
      <Box>
        <Text color="green">{">"} </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={async (v) => {
            if (pending) return;
            const line = v.trim();
            if (!line) return;
            setValue("");
            setPending(true);
            try {
              await onSubmit(line);
            } finally {
              setPending(false);
            }
          }}
        />
      </Box>
      {history.length > 0 && (
        <Box>
          <Text dimColor>history: {history.length} entries</Text>
        </Box>
      )}
    </Box>
  );
};