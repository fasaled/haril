import React, { useMemo } from "react";
import { Box, Text, useInput } from "ink";

export interface ActivityEntry {
  id: number;
  command: string;
  ok: boolean;
  text: string;
}

export interface ActivityPanelProps {
  entries: ActivityEntry[];
  isFocused?: boolean;
  scrollOffset: number;
  onScroll: (direction: "up" | "down" | "pageUp" | "pageDown" | "first" | "last") => void;
  height?: number;
  onClose?: () => void;
}

interface OutputLine {
  id: string;
  text: string;
  tone: "cmd" | "error" | "success" | "warning" | "info" | "muted" | "default";
}

export const ActivityPanel: React.FC<ActivityPanelProps> = ({
  entries,
  isFocused = false,
  scrollOffset,
  onScroll,
  height = 5,
  onClose,
}) => {
  const visibleLinesCount = Math.max(2, height - 2);

  // Flatten entries and output text into individual styled lines
  const allLines = useMemo<OutputLine[]>(() => {
    if (entries.length === 0) {
      return [
        {
          id: "init",
          text: "Ready. Type a command (e.g. `help`, `open <path.haril>`, `ls`, `events`, `summary`) to see activity.",
          tone: "muted",
        },
      ];
    }

    const lines: OutputLine[] = [];
    for (const e of entries) {
      lines.push({
        id: `cmd-${e.id}`,
        text: `❯ ${e.command}`,
        tone: "cmd",
      });

      const raw = (e.text || "").split("\n");
      for (let i = 0; i < raw.length; i++) {
        const line = raw[i]!;
        let tone: OutputLine["tone"] = e.ok ? "default" : "error";
        if (line.startsWith("✓") || line.toLowerCase().includes("complete:") || line.toLowerCase().includes("ready")) {
          tone = "success";
        } else if (line.startsWith("!") || line.startsWith("warning") || line.startsWith("note:")) {
          tone = "warning";
        } else if (line.startsWith("error:") || line.startsWith("failed")) {
          tone = "error";
        } else if (line.startsWith("{") || line.startsWith("}") || line.startsWith("  \"") || line.startsWith("[")) {
          tone = "info";
        } else if (line.trim().length === 0) {
          tone = "muted";
        }

        lines.push({
          id: `line-${e.id}-${i}`,
          text: line,
          tone,
        });
      }
    }
    return lines;
  }, [entries]);

  const maxOffset = Math.max(0, allLines.length - visibleLinesCount);
  const clampedOffset = Math.max(0, Math.min(scrollOffset, maxOffset));

  const start = Math.max(0, allLines.length - visibleLinesCount - clampedOffset);
  const end = Math.min(allLines.length, start + visibleLinesCount);
  const visibleLines = allLines.slice(start, end);

  useInput(
    (input, key) => {
      if (key.upArrow || (input === "k" && (key.ctrl || key.meta))) onScroll("up");
      if (key.downArrow || (input === "j" && (key.ctrl || key.meta))) onScroll("down");
      if (key.pageUp) onScroll("pageUp");
      if (key.pageDown) onScroll("pageDown");
      if (key.home || input === "g") onScroll("first");
      if (key.end || (input === "G" && key.shift)) onScroll("last");
      if (key.escape && onClose) onClose();
    },
    { isActive: isFocused }
  );

  const borderColor = isFocused ? "cyan" : "gray";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      height={height}
      width="100%"
      paddingX={1}
      flexShrink={0}
    >
      {/* Header bar */}
      <Box justifyContent="space-between">
        <Text>
          <Text bold color={isFocused ? "cyan" : "gray"}>
            ACTIVITY
          </Text>
          <Text dimColor>
            {" "}
            ({clampedOffset > 0 ? `scrolled -${clampedOffset}` : "latest"} · {allLines.length} lines)
          </Text>
        </Text>
        <Text dimColor>
          {isFocused
            ? "↑/↓ or k/j scroll  PgUp/PgDn  Home/End  Esc to prompt"
            : "PgUp/PgDn to scroll  Ctrl+A to focus"}
        </Text>
      </Box>

      {/* Content lines */}
      <Box flexDirection="column" height={visibleLinesCount} overflow="hidden">
        {visibleLines.map((line) => {
          let color: string | undefined;
          let bold = false;
          let dim = false;

          switch (line.tone) {
            case "cmd":
              color = "cyan";
              bold = true;
              break;
            case "error":
              color = "red";
              bold = true;
              break;
            case "success":
              color = "green";
              break;
            case "warning":
              color = "yellow";
              break;
            case "info":
              color = "cyan";
              break;
            case "muted":
              dim = true;
              break;
            default:
              color = "white";
              break;
          }

          return (
            <Text key={line.id} color={color} bold={bold} dimColor={dim} wrap="truncate-end">
              {line.text.length > 0 ? line.text : " "}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
};