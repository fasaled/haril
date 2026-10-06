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
  /** Available width inside the panel (already accounting for borders/padding).
   *  Used to wrap long values onto multiple rows and keep labels aligned. */
  width?: number;
}

export const EventDetail: React.FC<EventDetailProps> = ({ event, fileKey, isFocused, onClose, baseNs, width }) => {
  const sections = useMemo(
    () => (event ? buildSections(event, baseNs, width) : []),
    [event, baseNs, width],
  );

  if (!event) {
    return (
      <InkBox flexDirection="column" borderStyle="round" borderColor={isFocused ? "cyan" : "gray"} width="100%" height="100%">
        <Box flexDirection="column" flexGrow={1} marginLeft={1} marginTop={1}>
          <Text dimColor>  Select a row in the event list to see its details.</Text>
        </Box>
      </InkBox>
    );
  }

  // Layout columns:
  //  - 1 col of left padding (marginLeft=1)
  //  - LABEL_W cols reserved for the label ("Process:     ")
  //  - 1 col of gap
  //  - everything else is the value column, which is allowed to wrap.
  const LABEL_W = 12;
  const innerW = width ? Math.max(8, width - 1) : undefined; // minus outer border
  const valueW = innerW ? Math.max(4, innerW - LABEL_W - 1) : undefined;

  return (
    <InkBox flexDirection="column" borderStyle="round" borderColor={isFocused ? "cyan" : "gray"} width="100%" height="100%">
      <Box flexDirection="column" flexGrow={1} marginLeft={1} marginTop={1} overflow="hidden">
        {sections.map((section, si) => (
          <Box key={si} flexDirection="column" marginBottom={1} width={innerW ?? "100%"} overflow="hidden">
            <Box width="100%" overflow="hidden">
              <Text color="cyan" bold wrap="truncate-end">{section.title}</Text>
            </Box>
            {section.lines.map((line, li) => (
              <Box key={li} flexDirection="row" width="100%" overflow="hidden">
                <Box width={LABEL_W} flexShrink={0}>
                  <Text dimColor wrap="truncate-end">{line.label}</Text>
                </Box>
                <Box width={valueW ?? "100%"} flexGrow={1} overflow="hidden">
                  <Text wrap="wrap">{line.value}</Text>
                </Box>
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

/** Truncates `s` so it fits within `max` columns, appending an ellipsis when
 *  cut. Returns the input unchanged when `max` is not a positive number.
 *
 *  This is needed because Ink's `wrap="wrap"` does not respect a sub-box width
 *  when a single "word" is wider than that box: it falls back to splitting the
 *  word mid-character at the longest-word length. Pre-clipping the string to
 *  the box width ensures the wrap always lands on word boundaries. */
function clip(s: string, max: number | undefined): string {
  if (!max || max < 2) return s;
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

interface DetailLine {
  label: string;
  value: string;
}

interface DetailSection {
  title: string;
  lines: DetailLine[];
}

function buildSections(
  event: NormalizedEvent,
  baseNs: unknown,
  panelWidth?: number,
): DetailSection[] {
  // Each row is rendered as a `<Box flexDirection="row">` whose value column
  // is `valueW` columns wide. We mirror that math here so values are clipped
  // (with ellipsis) to a width that Ink can honour with normal word wrap.
  const LABEL_W = 12;
  const innerW = panelWidth ? Math.max(8, panelWidth - 1) : undefined;
  const valueW = innerW ? Math.max(4, innerW - LABEL_W - 1) : undefined;
  const c = (v: string) => clip(v, valueW);

  const secs: DetailSection[] = [];
  const ts = eventTimestampNs(event);

  const basic: DetailLine[] = [
    { label: "Kind:",      value: c(String(event.eventKind ?? "?")) },
    { label: "Source:",    value: c(String(event.source ?? "?").toUpperCase()) },
    { label: "Timestamp:", value: c(`${formatEventTime(ts, baseNs)}${ts !== null ? `  (${ts} ns)` : ""}`) },
    { label: "PID/TID:",   value: c(`${event.pid > 0 ? event.pid : "?"} / ${event.tid > 0 ? event.tid : "?"}`) },
    { label: "Process:",   value: c(event.processImageName || "?") },
    { label: "IRP:",       value: c(event.irpPtr ? hex(event.irpPtr) : "?") },
    { label: "NT Status:", value: c(hex(event.ntStatus)) },
  ];
  secs.push({ title: "Basic", lines: basic });

  if (event.observedPath) {
    secs.push({
      title: "Path",
      lines: [{ label: "Observed:", value: c(event.observedPath) }],
    });
  }

  const ioLines: DetailLine[] = [];
  if (isSet(event.byteOffset)) ioLines.push({ label: "Offset:", value: c(String(event.byteOffset)) });
  if (isSet(event.byteLength)) ioLines.push({ label: "Length:", value: c(String(event.byteLength)) });
  if (ioLines.length > 0) secs.push({ title: "I/O", lines: ioLines });

  const createLines: DetailLine[] = [];
  if (isSet(event.shareAccess))       createLines.push({ label: "Share:",       value: c(hex(event.shareAccess)) });
  if (isSet(event.createOptions))     createLines.push({ label: "Options:",     value: c(hex(event.createOptions)) });
  if (isSet(event.createDisposition)) createLines.push({ label: "Disposition:", value: c(hex(event.createDisposition)) });
  if (createLines.length > 0) secs.push({ title: "Create/Share", lines: createLines });

  if (isSet(event.sourceEventIndex)) {
    secs.push({
      title: "Source",
      lines: [{ label: "Source Index:", value: c(String(event.sourceEventIndex)) }],
    });
  }

  return secs;
}