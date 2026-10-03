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
  const etw = sourceStatus.etw;
  const usn = sourceStatus.usn;
  const fsw = sourceStatus.fsw;

  const etwStatus = etw.available 
    ? `ETW: ${etw.eventsObserved?.toLocaleString() || 0} events`
    : `ETW: off (rc=${etw.startRc ?? "n/a"})`;
  const usnStatus = usn.available 
    ? `USN: ${usn.recordsRead?.toLocaleString() || 0} records`
    : `USN: off (rc=${usn.startRc ?? "n/a"})`;
  const fswStatus = `FSW: ${fsw.notifications || 0} notifications`;

  const captureInfo = snapshot.packageManifest?.sources;

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

      {captureInfo && (
        <Box marginTop={1} marginLeft={1}>
          <Text color="cyan">Capture Summary:</Text>
          <Text dimColor>
            {"  Events: " + (captureInfo.recordCounts?.events ?? 0).toLocaleString()}
          </Text>
          <Text dimColor>
            {"  Inventories: " + (captureInfo.recordCounts?.inventories ?? 0).toLocaleString()}
          </Text>
          <Text dimColor>
            {"  USN: " + (captureInfo.recordCounts?.usn ?? 0).toLocaleString()}
          </Text>
          <Text dimColor>
            {"  Notifications: " + (captureInfo.recordCounts?.notifications ?? 0).toLocaleString()}
          </Text>
        </Box>
      )}

      <Box marginTop={1} marginLeft={1}>
        <Text color="red">Press [s] stop-capture  [f] force-quit-capture  [q] quit</Text>
      </Box>
    </InkBox>
  );
};