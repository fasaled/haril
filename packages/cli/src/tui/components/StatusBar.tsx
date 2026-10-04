import React from "react";
import { Box, Text } from "ink";
import type { SessionSnapshot } from "@haril-ts/core";
import { displayCwd } from "../format.ts";

export const StatusBar: React.FC<{ snapshot: SessionSnapshot }> = ({ snapshot }) => {
  const filter = snapshot.activeEventFilter;
  const filterDesc = filter
    ? filter.failedOnly
      ? "filter: failed only"
      : filter.opKinds?.length
      ? `filter: op=${filter.opKinds.join(",")}`
      : filter.pid != null
      ? `filter: pid=${filter.pid}`
      : filter.processName
      ? `filter: process=${filter.processName}`
      : ""
    : "";

  return (
    <Box paddingX={1} flexShrink={0}>
      <Text dimColor>
        cwd: <Text color="white">{displayCwd(snapshot)}</Text>
        {snapshot.heuristicsEnabled ? <Text color="magenta"> · heuristics: on</Text> : null}
        {snapshot.zoomRange ? <Text color="cyan"> · zoomed</Text> : null}
        {filterDesc ? <Text color="yellow"> · {filterDesc}</Text> : null}
      </Text>
    </Box>
  );
};