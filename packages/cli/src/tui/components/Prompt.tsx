import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import type { HarilSession, Phase, CompleteContext } from "../../../../core/src/index.ts";
import { complete, getVisibleSuggestionsWindow, applyCompletion } from "../../../../core/src/index.ts";

export interface OutputLine {
  id: string;
  text: string;
  tone?: "cmd" | "error" | "success" | "warning" | "info" | "muted" | "default";
}

export interface PromptProps {
  hint: string;
  history: readonly string[];
  phase: Phase;
  session: HarilSession;
  onSubmit: (line: string) => void | Promise<void>;
  isFocused?: boolean;
  width?: number;
  height?: number;
  terminalLines?: OutputLine[];
  onTerminalScroll?: (direction: "up" | "down" | "pageUp" | "pageDown" | "first" | "last") => void;
  terminalScrollOffset?: number;
  queueCount?: number;
  activeTask?: string | null;
}

export const Prompt: React.FC<PromptProps> = ({
  hint,
  history,
  phase,
  session,
  onSubmit,
  isFocused = true,
  width = 80,
  height = 8,
  terminalLines = [],
  onTerminalScroll,
  terminalScrollOffset = 0,
  queueCount = 0,
  activeTask = null,
}) => {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [historyPos, setHistoryPos] = useState(-1);
  const [pending, setPending] = useState(false);

  const computeSuggestions = useCallback(
    (inputLine: string): string[] => {
      const snap = session.snapshot();
      const ctx: CompleteContext = {
        cwd: snap.cwd,
        knownDirectories: [],
        knownFileKeys: snap.selectedFileKey ? [snap.selectedFileKey] : [],
        knownProcessNames: [],
        identityKinds: ["exact", "path"],
        phase,
      };
      const res = complete(inputLine, inputLine.length, ctx);
      return res.map((c) => c.text);
    },
    [session, phase]
  );

  const availableWidth = Math.max(20, width - 6);
  const visibleSuggestions = getVisibleSuggestionsWindow(suggestions, suggestionIndex, availableWidth);

  // Terminal output display calculation
  const hasSuggestions = visibleSuggestions.items.length > 0;
  const initialOutputHeight = Math.max(2, height - 2 - (hasSuggestions ? 1 : 0));
  const maxScroll = Math.max(0, terminalLines.length - initialOutputHeight);
  const clampedScroll = Math.max(0, Math.min(terminalScrollOffset, maxScroll));
  const hasHeader = queueCount > 0 || !!activeTask || clampedScroll > 0;
  const outputAreaHeight = Math.max(2, height - 2 - (hasSuggestions ? 1 : 0) - (hasHeader ? 1 : 0));
  const startIdx = Math.max(0, terminalLines.length - outputAreaHeight - clampedScroll);
  const endIdx = Math.min(terminalLines.length, startIdx + outputAreaHeight);
  const visibleLines = terminalLines.slice(startIdx, endIdx);

  const refreshSuggestions = useCallback(
    (v: string) => {
      setSuggestions(computeSuggestions(v));
      setSuggestionIndex(0);
    },
    [computeSuggestions],
  );

  useInput(
    (input, key) => {
      if (pending) return;

      // Terminal output scrolling
      if (key.pageUp || (key.shift && key.upArrow)) {
        if (onTerminalScroll) onTerminalScroll("pageUp");
        return;
      }
      if (key.pageDown || (key.shift && key.downArrow)) {
        if (onTerminalScroll) onTerminalScroll("pageDown");
        return;
      }

      if (key.tab) {
        const currentList = suggestions.length > 0 ? suggestions : computeSuggestions(value);
        if (currentList.length === 0) return;

        const nextIndex = suggestions.length > 0 ? (suggestionIndex + 1) % currentList.length : 0;
        const selected = currentList[nextIndex]!;
        const completed = applyCompletion(value, selected);

        setValue(completed);
        setCursor(completed.length);
        setSuggestions(currentList);
        setSuggestionIndex(nextIndex);
        return;
      }

      if (key.upArrow) {
        if (history.length === 0) return;
        const nextPos = Math.min(historyPos + 1, history.length - 1);
        setHistoryPos(nextPos);
        const historyValue = history[history.length - 1 - nextPos] ?? "";
        setValue(historyValue);
        setCursor(historyValue.length);
        setSuggestions(computeSuggestions(historyValue));
        setSuggestionIndex(0);
        return;
      }

      if (key.downArrow) {
        if (historyPos > 0) {
          const nextPos = historyPos - 1;
          setHistoryPos(nextPos);
          const historyValue = history[history.length - 1 - nextPos] ?? "";
          setValue(historyValue);
          setCursor(historyValue.length);
          setSuggestions(computeSuggestions(historyValue));
          setSuggestionIndex(0);
        } else if (historyPos === 0) {
          setHistoryPos(-1);
          setValue("");
          setCursor(0);
          setSuggestions([]);
          setSuggestionIndex(0);
        }
        return;
      }

      if (key.escape) {
        setSuggestions([]);
        setSuggestionIndex(0);
        return;
      }

      // Ctrl/Meta combos are panel shortcuts handled by App (Ctrl+E/D/F,
      // Ctrl+Q). They must never be typed into the prompt line. The
      // ink-text-input we used before appended them as plain letters —
      // pressing Ctrl+E while the prompt was focused printed a stray "e".
      if (key.ctrl || key.meta) return;

      if (key.return) {
        const line = value.trim();
        if (!line) return;
        setValue("");
        setCursor(0);
        setSuggestions([]);
        setSuggestionIndex(0);
        setHistoryPos(-1);
        setPending(true);
        try {
          void (async () => {
            try {
              await onSubmit(line);
            } finally {
              setPending(false);
            }
          })();
        } catch {
          setPending(false);
        }
        return;
      }

      if (key.leftArrow) {
        setCursor(Math.max(0, cursor - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor(Math.min(value.length, cursor + 1));
        return;
      }
      if (key.home) {
        setCursor(0);
        return;
      }
      if (key.end) {
        setCursor(value.length);
        return;
      }

      if (key.backspace || key.delete) {
        if (cursor > 0) {
          const next = value.slice(0, cursor - 1) + value.slice(cursor);
          setValue(next);
          setCursor(cursor - 1);
          refreshSuggestions(next);
          setHistoryPos(-1);
        }
        return;
      }

      // Printable input: single keystrokes or pasted chunks.
      if (input && input.length > 0) {
        const next = value.slice(0, cursor) + input + value.slice(cursor);
        setValue(next);
        setCursor(cursor + input.length);
        refreshSuggestions(next);
        setHistoryPos(-1);
      }
    },
    { isActive: isFocused }
  );

  const borderColor = isFocused ? "cyan" : "gray";

  // Render the input line with a fake block cursor (inverse video on the
  // character under the caret, or an inverse space at the end).
  const before = value.slice(0, cursor);
  const at = cursor < value.length ? value[cursor]! : " ";
  const after = cursor < value.length ? value.slice(cursor + 1) : "";

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
      {/* Header only when queue/task/scroll active */}
      {hasHeader && (
        <Box justifyContent="space-between">
          <Text dimColor>
            {clampedScroll > 0 ? `(scrolled -${clampedScroll} lines)` : ""}
          </Text>
          <Box>
            {queueCount > 0 ? <Text color="yellow">queue: {queueCount} pending  </Text> : null}
            {activeTask ? <Text dimColor>running: {activeTask}</Text> : null}
          </Box>
        </Box>
      )}

      {/* Terminal output area */}
      <Box flexDirection="column" height={outputAreaHeight} overflow="hidden">
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

      {/* Autocomplete suggestions bar (only when active candidates exist) */}
      {hasSuggestions && (
        <Box height={1} overflow="hidden">
          <Box flexDirection="row">
            {visibleSuggestions.hasPrevious && <Text color="gray">... </Text>}
            {visibleSuggestions.items.map((item, idx) => (
              <Text
                key={`${item.text}-${item.originalIndex}`}
                color={item.isSelected ? "cyan" : "gray"}
                bold={item.isSelected}
              >
                {item.isSelected ? `[${item.text}]` : item.text}
                {idx < visibleSuggestions.items.length - 1 ? "  ·  " : ""}
              </Text>
            ))}
            {visibleSuggestions.hasNext && <Text color="gray"> ...</Text>}
          </Box>
        </Box>
      )}

      {/* Input line */}
      <Box>
        <Text color="cyan" bold>
          ❯{" "}
        </Text>
        {isFocused ? (
          <Text>
            {before}
            <Text inverse>{at}</Text>
            {after}
          </Text>
        ) : (
          <Text>{value.length > 0 ? value : " "}</Text>
        )}
      </Box>
    </Box>
  );
};
