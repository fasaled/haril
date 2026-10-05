import React, { useMemo } from "react";
import { Box, Text } from "ink";
import type { NormalizedEvent, FileKey } from "../../../../core/src/index.ts";
import { Box as InkBox } from "ink";
import { eventTimestampNs, formatEventTime } from "../format.ts";

export interface EventDetailProps {
  event: NormalizedEvent | null;
  fileKey: FileKey | null;
  isFocused: boolean;
  onClose: () => void;
  /** Capture start (QPC ns); timestamps are shown relative to it. */
  baseNs?: unknown;
}

export const EventDetail: React.FC<EventDetailProps> = ({ event, fileKey, isFocused, onClose, baseNs }) => {
  const sections = useMemo(() => (event ? buildSections(event, baseNs) : []), [event, baseNs]);

  if (!event) {
    return (
      <InkBox flexDirection="column" borderStyle="round" borderColor={isFocused ? "cyan" : "gray"} width="100%" height="100%">
      </InkBox>
    );
  }

  return (
    <InkBox flexDirection="column" borderStyle="round" borderColor={isFocused ? "cyan" : "gray"} width="100%" height="100%">
      <Box flexDirection="column" flexGrow={1} marginLeft={1} marginTop={1}>
        {sections.map((section, si) => (
          <Box key={si} flexDirection="column" marginBottom={1}>
            <Text color="cyan" bold>{section.title}</Text>
            {section.lines.map((line, li) => (
              <Box key={li} marginLeft={2}>
                <Text dimColor>{line}</Text>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    </InkBox>
  );
};

const isSet = (v: unknown): boolean => v !== null && v !== undefined;

function hex(v: unknown): string {
  if (!isSet(v)) return "?";
  if (typeof v === "string") return v.startsWith("0x") ? v : v;
  if (typeof v === "number" || typeof v === "bigint") {
    const n = typeof v === "number" ? v >>> 0 : v;
    return "0x" + n.toString(16);
  }
  return String(v);
}

function buildSections(event: NormalizedEvent, baseNs: unknown): Array<{ title: string; lines: string[] }> {
  const secs: Array<{ title: string; lines: string[] }> = [];
  const ts = eventTimestampNs(event);

  secs.push({
    title: "Basic",
    lines: [
      `Kind:        ${event.eventKind}`,
      `Source:      ${String(event.source ?? "?").toUpperCase()}`,
      `Timestamp:   ${formatEventTime(ts, baseNs)}${ts !== null ? ` (${ts} ns)` : ""}`,
      `PID/TID:     ${event.pid > 0 ? event.pid : "?"} / ${event.tid > 0 ? event.tid : "?"}`,
      `Process:     ${event.processImageName || "?"}`,
      `IRP:         ${event.irpPtr ? hex(event.irpPtr) : "?"}`,
      `NT Status:   ${hex(event.ntStatus)}`,
    ],
  });

  if (event.observedPath) {
    secs.push({ title: "Path", lines: [`Observed:  ${event.observedPath}`] });
  }

  if (isSet(event.byteOffset) || isSet(event.byteLength)) {
    secs.push({
      title: "I/O",
      lines: [
        `Offset:   ${isSet(event.byteOffset) ? String(event.byteOffset) : "?"}`,
        `Length:   ${isSet(event.byteLength) ? String(event.byteLength) : "?"}`,
      ],
    });
  }

  if (isSet(event.shareAccess) || isSet(event.createOptions) || isSet(event.createDisposition)) {
    secs.push({
      title: "Create/Share",
      lines: [
        `Share:       ${hex(event.shareAccess)}`,
        `Options:     ${hex(event.createOptions)}`,
        `Disposition: ${hex(event.createDisposition)}`,
      ],
    });
  }

  if (isSet(event.sourceEventIndex)) {
    secs.push({ title: "Source", lines: [`Source Index: ${event.sourceEventIndex}`] });
  }

  return secs;
}