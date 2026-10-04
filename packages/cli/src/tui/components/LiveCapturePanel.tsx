import React, { useMemo, useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { SessionSnapshot, Phase } from "@haril-ts/core";
import { Box as InkBox } from "ink";

export interface LiveCapturePanelProps {
  snapshot: SessionSnapshot;
  isFocused: boolean;
  phase: Phase;
}

export const LiveCapturePanel: React.FC<LiveCapturePanelProps> = ({ snapshot, isFocused, phase }) => {
  const [elapsed, setElapsed] = useState(0);
  
  useEffect(() => {
    if (phase === "live-capture") {
      const id = setInterval(() => setElapsed(e => e + 1), 1000);
      return () => clearInterval(id);
    }
  }, [phase]);

  const elapsedStr = useMemo(() => {
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }, [elapsed]);

  const sourceStatus = snapshot.sourceStatus;
  const manifest = snapshot.packageManifest;
  const etwSource = manifest?.sources.etw;
  const usnSource = manifest?.sources.usn;
  const fswSource = manifest?.sources.fsw;

  const etwStatus = sourceStatus.etw
    ? `ETW: ${etwSource ? etwSource.eventsObserved.toLocaleString() : "active"} events`
    : `ETW: off (rc=${etwSource?.startRc ?? "n/a"})`;
  const usnStatus = sourceStatus.usn
    ? `USN: ${usnSource ? usnSource.recordsRead.toLocaleString() : "active"} records`
    : `USN: off (rc=${usnSource?.startRc ?? "n/a"})`;
  const fswStatus = `FSW: ${fswSource ? fswSource.notifications : (sourceStatus.fsw ? "active" : "off")} notifications`;

  const counts = manifest?.recordCounts;

  return (
    <InkBox flexDirection="column" borderStyle="round" borderColor={isFocused ? "green" : "gray"} width="100%" height="100%">
      <Box>
        <Text backgroundColor={isFocused ? "green" : "gray"} color="white">
          {isFocused ? " LIVE CAPTURE (focused) " : " LIVE CAPTURE "}
        </Text>
      </Box>

      <Box flexDirection="column" marginLeft={1} marginTop={1}>
        <Text color="yellow">⏱  {elapsedStr}</Text>
        <Text>{"  " + etwStatus}</Text>
        <Text>{"  " + usnStatus}</Text>
        <Text>{"  " + fswStatus}</Text>
      </Box>

      {counts && (
        <Box flexDirection="column" marginTop={1} marginLeft={1}>
          <Text color="cyan">Capture Summary:</Text>
          <Text dimColor>
            {"  Events: " + (counts.events ?? 0).toLocaleString()}
          </Text>
          <Text dimColor>
            {"  Inventories: " + (counts.inventories ?? 0).toLocaleString()}
          </Text>
          <Text dimColor>
            {"  USN: " + (counts.usn ?? 0).toLocaleString()}
          </Text>
          <Text dimColor>
            {"  Notifications: " + (counts.notifications ?? 0).toLocaleString()}
          </Text>
        </Box>
      )}

      <Box marginTop={1} marginLeft={1}>
        <Text color="red">Press [s] stop-capture  [f] force-quit-capture  [q] quit</Text>
      </Box>
    </InkBox>
  );
};