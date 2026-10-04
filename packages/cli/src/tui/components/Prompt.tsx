import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { HarilSession, Phase, CompleteContext } from "@haril-ts/core";
import { complete, getVisibleSuggestionsWindow, applyCompletion } from "@haril-ts/core";

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
  const [inputVersion, setInputVersion] = useState(0);
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
        setInputVersion((v) => v + 1);
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
        setInputVersion((v) => v + 1);
        const nextSug = computeSuggestions(historyValue);
        setSuggestions(nextSug);
        setSuggestionIndex(0);
        return;
      }

      if (key.downArrow) {
        if (historyPos > 0) {
          const nextPos = historyPos - 1;
          setHistoryPos(nextPos);
          const historyValue = history[history.length - 1 - nextPos] ?? "";
          setValue(historyValue);
          setInputVersion((v) => v + 1);
          const nextSug = computeSuggestions(historyValue);
          setSuggestions(nextSug);
          setSuggestionIndex(0);
        } else if (historyPos === 0) {
          setHistoryPos(-1);
          setValue("");
          setInputVersion((v) => v + 1);
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
        <TextInput
          key={inputVersion}
          value={value}
          focus={isFocused}
          onChange={(v) => {
            setValue(v);
            setHistoryPos(-1);
            const sug = computeSuggestions(v);
            setSuggestions(sug);
            setSuggestionIndex(0);
          }}
          onSubmit={async (v) => {
            if (pending) return;
            const line = v.trim();
            if (!line) return;
            setValue("");
            setSuggestions([]);
            setSuggestionIndex(0);
            setHistoryPos(-1);
            setPending(true);
            try {
              await onSubmit(line);
            } finally {
              setPending(false);
            }
          }}
        />
      </Box>
    </Box>
  );
};