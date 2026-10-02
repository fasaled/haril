import React from "react";
import { Box, Text } from "ink";
import type { SessionSnapshot } from "@haril-ts/core";

export const Header: React.FC<{ snapshot: SessionSnapshot }> = ({ snapshot }) => {
  const label = headerLabel(snapshot);
  return (
    <Box>
      <Text backgroundColor="gray" color="white">
        {" "}
        {label}{" "}
      </Text>
    </Box>
  );
};

function headerLabel(s: SessionSnapshot): string {
  if (s.phase === "live-capture") {
    return `Haril · live-capture · cwd=${s.cwd} · sources: ETW/USN/FSW (see activity panel)`;
  }
  if (s.phase === "analyze") {
    return `Haril · analyze · ${s.packagePath ?? "?"} · cwd=${s.cwd}`;
  }
  return `Haril · empty · cwd=${s.cwd}`;
}