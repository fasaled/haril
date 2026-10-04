import React from "react";
import { Box, Text } from "ink";
import type { SessionSnapshot } from "@haril-ts/core";

export const Header: React.FC<{ snapshot: SessionSnapshot }> = ({ snapshot }) => {
  const sources = snapshot.sourceStatus;
  const phaseColor =
    snapshot.phase === "analyze"
      ? "green"
      : snapshot.phase === "live-capture"
      ? "yellow"
      : "cyan";

  return (
    <Box flexDirection="column" flexShrink={0} paddingX={1} marginBottom={0}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold color="cyan">
            Haril
          </Text>
          <Text dimColor>  ·  File Lifecycle Reconstruction</Text>
          {snapshot.packagePath ? (
            <Text color="white">  [{snapshot.packagePath}]</Text>
          ) : null}
        </Text>
        <Text>
          <Text dimColor>phase: </Text>
          <Text color={phaseColor} bold>
            {snapshot.phase}
          </Text>
          <Text dimColor>  ·  sources: [</Text>
          <Text color={sources.etw ? "green" : "gray"}>ETW</Text>
          <Text dimColor> </Text>
          <Text color={sources.usn ? "yellow" : "gray"}>USN</Text>
          <Text dimColor> </Text>
          <Text color={sources.fsw ? "cyan" : "gray"}>FSW</Text>
          <Text dimColor>]</Text>
        </Text>
      </Box>
      <Box borderStyle="single" borderTop={false} borderLeft={false} borderRight={false} borderColor="gray" />
    </Box>
  );
};