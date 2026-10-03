import React, { useMemo } from "react";
import { Box, Text } from "ink";
import type { NormalizedEvent, FileKey } from "@haril-ts/core";
import { Box as InkBox } from "ink";

export interface EventDetailProps {
  event: NormalizedEvent | null;
  fileKey: FileKey | null;
  isFocused: boolean;
  onClose: () => void;
}

export const EventDetail: React.FC<EventDetailProps> = ({ event, fileKey, isFocused, onClose }) => {
  if (!event) {
    return (
      <InkBox flexDirection="column" borderStyle="round" borderColor={isFocused ? "cyan" : "gray"} width="100%" height="100%">
        <Box>
          <Text backgroundColor={isFocused ? "cyan" : "gray"} color="white">
            {isFocused ? " EVENT DETAILS (focused) " : " EVENT DETAILS "}
          </Text>
        </Box>
        <Text dimColor marginLeft={1} marginTop={1}>Select an event to view details</Text>
      </InkBox>
    );
  }

  const sections = useMemo(() => {
    const secs: Array<{ title: string; lines: string[] }> = [];
    
    secs.push({
      title: "Basic",
      lines: [
        `Kind:        ${event.eventKind}`,
        `Source:      ${event.source.toUpperCase()}`,
        `Timestamp:   ${formatNs(event.timestamp_ns)} (${event.timestamp_ns} ns)`,
        `PID/TID:     ${event.pid} / ${event.tid}`,
        `Process:     ${event.processImageName || "?"}`,
        `IRP:         ${event.irpPtr ? "0x" + event.irpPtr.toString(16) : "?"}`,
        `NT Status:   ${event.ntStatus !== null ? "0x" + event.ntStatus.toString(16) : "?"}`,
      ],
    });

    if (event.observedPath) {
      secs.push({
        title: "Path",
        lines: [`Observed:  ${event.observedPath}`],
      });
    }

    if (event.byteOffset !== null || event.byteLength !== null) {
      secs.push({
        title: "I/O",
        lines: [
          `Offset:   ${event.byteOffset !== null ? event.byteOffset.toString() : "?"}`,
          `Length:   ${event.byteLength !== null ? event.byteLength.toString() : "?"}`,
        ],
      });
    }

    if (event.shareAccess !== null || event.createOptions !== null || event.createDisposition !== null) {
      secs.push({
        title: "Create/Share",
        lines: [
          `Share:       ${event.shareAccess !== null ? "0x" + event.shareAccess.toString(16) : "?"}`,
          `Options:     ${event.createOptions !== null ? "0x" + event.createOptions.toString(16) : "?"}`,
          `Disposition: ${event.createDisposition !== null ? "0x" + event.createDisposition.toString(16) : "?"}`,
        ],
      });
    }

    if (event.sourceEventIndex !== undefined) {
      secs.push({
        title: "Source",
        lines: [`Source Index: ${event.sourceEventIndex}`],
      });
    }

    return secs;
  }, [event]);

  return (
    <InkBox flexDirection="column" borderStyle="round" borderColor={isFocused ? "cyan" : "gray"} width="100%" height="100%">
      <Box>
        <Text backgroundColor={isFocused ? "cyan" : "gray"} color="white">
          {isFocused ? " EVENT DETAILS (focused) " : " EVENT DETAILS "}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} marginLeft={1} marginTop={1}>
        {sections.map((section, si) => (
          <Box key={si} marginBottom={1}>
            <Text color="cyan" bold>{section.title}</Text>
            {section.lines.map((line, li) => (
              <Text key={li} dimColor marginLeft={2}>{line}</Text>
            ))}
          </Box>
        ))}
      </Box>
    </InkBox>
  );
};

function formatNs(ns: bigint): string {
  const ms = Number(ns / 1000000n);
  const date = new Date(ms);
  return date.toISOString().replace("T", " ").slice(0, 23);
}