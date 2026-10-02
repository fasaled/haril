import React from "react";
import { Box, Text } from "ink";
import type { SessionSnapshot } from "@haril-ts/core";

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
    <Box>
      <Text dimColor>
        {" : \\ s v c h ? n N o f p e r  Ctrl+Q  "}
        {filterDesc ? " · " + filterDesc : ""}
      </Text>
    </Box>
  );
};