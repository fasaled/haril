import React, { useState, useEffect, useMemo, useRef } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { HarilSession, SessionSnapshot, NormalizedEvent, EventKind, Phase } from "@haril-ts/core";
import { Header } from "./components/Header.tsx";
import { Prompt } from "./components/Prompt.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { HelpOverlay } from "./components/HelpOverlay.tsx";
import { ActivityPanel } from "./components/ActivityPanel.tsx";
import { FileBrowser, type FileItem } from "./components/FileBrowser.tsx";
import { EventList } from "./components/EventList.tsx";
import { EventDetail } from "./components/EventDetail.tsx";
import { LiveCapturePanel } from "./components/LiveCapturePanel.tsx";

export interface ActivityEntry {
  id: number;
  command: string;
  ok: boolean;
  text: string;
}

export interface AppProps {
  session: HarilSession;
}

export const App: React.FC<AppProps> = ({ session }) => {
  const { exit } = useApp();

  // Core state
  const [snap, setSnap] = useState<SessionSnapshot>(() => session.snapshot());

  // File browser state
  const [files, setFiles] = useState<FileItem[]>([]);
  const [fileLoading, setFileLoading] = useState(false);
  const [selectedFileKeyHash, setSelectedFileKeyHash] = useState<string | null>(null);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);

  // Event list state
  const [events, setEvents] = useState<NormalizedEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [selectedEventIndex, setSelectedEventIndex] = useState(0);
  const [selectedEvent, setSelectedEvent] = useState<NormalizedEvent | null>(null);

  // Event filter state
  const [eventFilter, setEventFilter] = useState<{ kinds?: EventKind[]; failedOnly?: boolean; pid?: number; process?: string; reset?: boolean }>({});

  // UI state
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [activityOpen, setActivityOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [focusedPanel, setFocusedPanel] = useState<"files" | "events" | "detail" | "prompt" | "help">("prompt");

  // useInput hook for TUI key handling
  useInput((input, key) => {
    // Global keys
    if (key.ctrl && input === "q") {
      exit();
      return;
    }
    if (input === "?") {
      setHelpOpen(v => !v);
      return;
    }
    if (input === ":" || input === "\\") {
      setFocusedPanel("prompt");
      return;
    }
    if (input === "h") {
      setActivityOpen(v => !v);
      return;
    }
    if (input === "f" && key.ctrl) {
      setFocusedPanel(focusedPanel === "files" ? "prompt" : "files");
      return;
    }
    if (input === "e" && key.ctrl) {
      setFocusedPanel(focusedPanel === "events" ? "prompt" : "events");
      return;
    }
    if (input === "d" && key.ctrl) {
      setFocusedPanel(focusedPanel === "detail" ? "prompt" : "detail");
      return;
    }

    // Panel-specific keys
    if (focusedPanel === "files") {
      if (key.upArrow || (input === "k" && (key.ctrl || key.meta))) handleFileNavigate("up");
      if (key.downArrow || (input === "j" && (key.ctrl || key.meta))) handleFileNavigate("down");
      if (key.home || input === "g") handleFileNavigate("first");
      if (key.end || (input === "G" && key.shift)) handleFileNavigate("last");
      if (key.pageUp) handleFileNavigate("pageUp");
      if (key.pageDown) handleFileNavigate("pageDown");
      if (key.return) {
        const filtered = getFilteredFiles();
        const entry = filtered[selectedFileIndex];
        if (entry) {
          setSelectedFileKeyHash(entry.fileKeyHash);
          loadEventsForKey(entry.fileKeyHash);
        }
      }
    }

    if (focusedPanel === "events") {
      if (key.upArrow || (input === "k" && (key.ctrl || key.meta))) handleEventNavigate("up");
      if (key.downArrow || (input === "j" && (key.ctrl || key.meta))) handleEventNavigate("down");
      if (key.home || input === "g") handleEventNavigate("first");
      if (key.end || (input === "G" && key.shift)) handleEventNavigate("last");
      if (key.pageUp) handleEventNavigate("pageUp");
      if (key.pageDown) handleEventNavigate("pageDown");
      if (key.return) {
        const filtered = getFilteredEvents();
        setSelectedEvent(filtered[selectedEventIndex] || null);
      }
      if (input === "f") {
        setEventFilter({ kinds: [] });
        return;
      }
      if (input === "x") {
        setEventFilter({ failedOnly: true });
        return;
      }
      if (input === "r") {
        setEventFilter({ reset: true });
        return;
      }
    }

    if (focusedPanel === "detail") {
      if (key.escape) {
        setSelectedEvent(null);
        setSelectedEventIndex(0);
        setFocusedPanel("prompt");
      }
      return;
    }
  });

  // Update snapshot
  useEffect(() => {
    setSnap(session.snapshot());
    const interval = setInterval(() => setSnap(session.snapshot()), 500);
    return () => clearInterval(interval);
  }, [session]);

  // Load files when entering analyze phase
  useEffect(() => {
    if (snap.phase === "analyze" && files.length === 0) {
      loadFiles();
    }
  }, [snap.phase, session]);

  // File navigation handlers
  const handleFileNavigate = (direction: "up" | "down" | "first" | "last" | "pageUp" | "pageDown") => {
    const filtered = getFilteredFiles();
    if (filtered.length === 0) return;

    let newIndex = selectedFileIndex;
    switch (direction) {
      case "up": newIndex = Math.max(0, selectedFileIndex - 1); break;
      case "down": newIndex = Math.min(filtered.length - 1, selectedFileIndex + 1); break;
      case "first": newIndex = 0; break;
      case "last": newIndex = filtered.length - 1; break;
      case "pageUp": newIndex = Math.max(0, selectedFileIndex - 20); break;
      case "pageDown": newIndex = Math.min(filtered.length - 1, selectedFileIndex + 20); break;
    }
    setSelectedFileIndex(newIndex);

    const entry = filtered[newIndex];
    if (entry) {
      setSelectedFileKeyHash(entry.fileKeyHash);
      loadEventsForKey(entry.fileKeyHash);
    }
  };

  const handleEventNavigate = (direction: "up" | "down" | "first" | "last" | "pageUp" | "pageDown") => {
    const filtered = getFilteredEvents();
    if (filtered.length === 0) return;

    let newIndex = selectedEventIndex;
    switch (direction) {
      case "up": newIndex = Math.max(0, selectedEventIndex - 1); break;
      case "down": newIndex = Math.min(filtered.length - 1, selectedEventIndex + 1); break;
      case "first": newIndex = 0; break;
      case "last": newIndex = filtered.length - 1; break;
      case "pageUp": newIndex = Math.max(0, selectedEventIndex - 15); break;
      case "pageDown": newIndex = Math.min(filtered.length - 1, selectedEventIndex + 15); break;
    }
    setSelectedEventIndex(newIndex);
    setSelectedEvent(filtered[newIndex] || null);
  };

  const getFilteredFiles = () => files;

  const getFilteredEvents = () => {
    let result = events;
    if (eventFilter.kinds?.length) {
      result = result.filter(e => eventFilter.kinds!.includes(e.eventKind));
    }
    if (eventFilter.failedOnly) {
      result = result.filter(e => e.ntStatus !== null && e.ntStatus !== 0);
    }
    if (eventFilter.pid != null) {
      result = result.filter(e => e.pid === eventFilter.pid);
    }
    if (eventFilter.process) {
      const lower = eventFilter.process.toLowerCase();
      result = result.filter(e => e.processImageName?.toLowerCase().includes(lower));
    }
    if (eventFilter.reset) {
      return events;
    }
    return result;
  };

  const loadFiles = async () => {
    if (snap.phase !== "analyze") return;
    setFileLoading(true);
    try {
      const result = await session.run("ls");
      if (result.ok && result.kind === "json" && result.data && typeof result.data === "object") {
        const items: FileItem[] = Array.isArray(result.data) ? (result.data as any) : ((result.data as any).items ?? []);
        setFiles(items);
        if (items.length > 0 && !selectedFileKeyHash) {
          const entry = items[0]!;
          setSelectedFileKeyHash(entry.fileKeyHash);
          loadEventsForKey(entry.fileKeyHash);
        }
      }
    } catch (e) {
      console.error("loadFiles error:", e);
    } finally {
      setFileLoading(false);
    }
  };

  const loadEventsForKey = async (target: string) => {
    setEventsLoading(true);
    try {
      const result = await session.run(`events ${target}`);
      if (result.ok && result.kind === "json" && result.data && typeof result.data === "object") {
        const items: NormalizedEvent[] = Array.isArray(result.data) ? (result.data as any) : ((result.data as any).items ?? []);
        setEvents(items);
        setSelectedEventIndex(0);
        setSelectedEvent(items[0] || null);
      }
    } catch (e) {
      console.error("loadEvents error:", e);
    } finally {
      setEventsLoading(false);
    }
  };

  // Prompt handler
  const onPromptSubmit = async (line: string) => {
    if (!line.trim()) return;
    const id = Date.now();
    const placeholder: ActivityEntry = {
      id,
      command: line,
      ok: true,
      text: "$ " + line,
    };
    setActivity(cur => [...cur, placeholder]);
    setActivityOpen(true);

    const result = await session.run(line);
    const text = formatResult(result);
    setActivity(cur => cur.map(e => e.id === id ? { ...e, ok: result.ok, text } : e));

    if ((result.data as any)?.action === "quit") {
      exit();
      return;
    }
    if ((result.data as any)?.action === "open-analyze") {
      await loadFiles();
    }
    if ((result.data as any)?.action === "close") {
      setSelectedFileKeyHash(null);
      setEvents([]);
    }
    setSnap(session.snapshot());
  };

  // UI hint
  const hint = useMemo(() => {
    if (snap.phase === "empty") return "open <path.haril> | start-capture --root <dir> --output <file.haril> --seconds <n>";
    if (snap.phase === "live-capture") return "stop-capture | force-quit-capture";
    return `package: ${snap.packagePath ?? "?"} — close`;
  }, [snap]);

  // Phase-specific render functions
  function renderEmptyPhase() {
    return (
      <Box flexDirection="column" width="100%" flexGrow={1}>
        <Header snapshot={snap} />
        <Box width="100%" borderStyle="single" borderColor="gray" paddingX={1}>
          <Text backgroundColor="gray" color="white">
            {snap.packagePath ? `Package: ${snap.packagePath}` : "No package loaded"}
          </Text>
        </Box>
        <Box flexDirection="row" flexGrow={1}>
          <Box width="35%" minWidth={30} borderStyle="single" borderColor="gray">
            <FileBrowser
              entries={files}
              selectedKeyHash={selectedFileKeyHash}
              onSelect={(entry) => {
                setSelectedFileKeyHash(entry.fileKeyHash);
                loadEventsForKey(entry.fileKeyHash);
              }}
              onNavigate={handleFileNavigate}
              isFocused={focusedPanel === "files"}
              filter={{}}
              loading={fileLoading}
            />
          </Box>
          <Box width="65%" minWidth={40} borderStyle="single" borderColor="gray">
            <Box marginLeft={1} marginTop={2}>
              <Text dimColor>
                Use 'open &lt;path.haril&gt;' or 'start-capture' to begin
              </Text>
            </Box>
          </Box>
        </Box>
        <StatusBar snapshot={snap} />
        <Prompt
          hint={hint}
          history={session.history() as string[]}
          onSubmit={onPromptSubmit}
          phase={snap.phase}
        />
        {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
      </Box>
    );
  }

  function renderLiveCapturePhase() {
    return (
      <Box flexDirection="column" width="100%" flexGrow={1}>
        <Header snapshot={snap} />
        <Box width="100%" borderStyle="single" borderColor="green" paddingX={1}>
          <Text backgroundColor="green" color="white">
            {snap.packagePath ? `Live Capture: ${snap.packagePath}` : "Live Capture in progress"}
          </Text>
        </Box>
        <Box width="100%" flexGrow={1} borderStyle="single" borderColor="green">
          <LiveCapturePanel
            snapshot={snap}
            isFocused={focusedPanel === "detail"}
            phase={snap.phase}
          />
        </Box>
        <StatusBar snapshot={snap} />
        <Prompt
          hint={hint}
          history={session.history() as string[]}
          onSubmit={onPromptSubmit}
          phase={snap.phase}
        />
        {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
      </Box>
    );
  }

  function renderAnalyzePhase() {
    return (
      <Box flexDirection="column" width="100%" flexGrow={1}>
        <Header snapshot={snap} />
        <Box width="100%" borderStyle="single" borderColor="gray" paddingX={1}>
          <Text backgroundColor="gray" color="white">
            {snap.packagePath ? `Package: ${snap.packagePath}` : "No package loaded"}
          </Text>
        </Box>
        <Box flexDirection="row" flexGrow={1}>
          <Box width="35%" minWidth={30} borderStyle="single" borderColor="gray">
            <FileBrowser
              entries={files}
              selectedKeyHash={selectedFileKeyHash}
              onSelect={(entry) => {
                setSelectedFileKeyHash(entry.fileKeyHash);
                loadEventsForKey(entry.fileKeyHash);
              }}
              onNavigate={handleFileNavigate}
              isFocused={focusedPanel === "files"}
              filter={{}}
              loading={fileLoading}
            />
          </Box>
          <Box width="45%" minWidth={40} borderStyle="single" borderColor="gray">
            {selectedFileKeyHash ? (
              <EventList
                events={events}
                fileKey={null}
                selectedIndex={selectedEventIndex}
                onSelect={(idx) => {
                  setSelectedEventIndex(idx);
                  setSelectedEvent(getFilteredEvents()[idx] || null);
                }}
                onNavigate={handleEventNavigate}
                onFilter={(f) => setEventFilter(f)}
                isFocused={focusedPanel === "events"}
                filter={eventFilter}
                loading={eventsLoading}
              />
            ) : (
              <Box marginLeft={1} marginTop={2}>
                <Text dimColor>
                  Select a file from the browser to view its events
                </Text>
              </Box>
            )}
          </Box>
          <Box width="20%" minWidth={25} borderStyle="single" borderColor="gray">
            {selectedEvent ? (
              <EventDetail
                event={selectedEvent}
                fileKey={null}
                isFocused={focusedPanel === "detail"}
                onClose={() => {
                  setSelectedEvent(null);
                  setSelectedEventIndex(0);
                }}
              />
            ) : (
              <Box marginLeft={1} marginTop={1}>
                <Text dimColor>
                  Select an event to view details (Esc to close)
                </Text>
              </Box>
            )}
          </Box>
        </Box>
        <StatusBar snapshot={snap} />
        <Prompt
          hint={hint}
          history={session.history() as string[]}
          onSubmit={onPromptSubmit}
          phase={snap.phase}
        />
        {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
      </Box>
    );
  }

  // Render based on phase
  if (snap.phase === "empty") {
    return renderEmptyPhase();
  }

  if (snap.phase === "live-capture") {
    return renderLiveCapturePhase();
  }

  return renderAnalyzePhase();
};

function formatResult(res: { ok: boolean; error?: string; data?: unknown; kind: string }): string {
  if (!res.ok) return res.error ?? "command failed";
  if (res.kind === "none") return "(ok)";
  if (res.kind === "json") {
    try {
      return JSON.stringify(res.data, null, 2);
    } catch {
      return String(res.data);
    }
  }
  if (typeof res.data === "string") return res.data;
  return JSON.stringify(res.data ?? null, null, 2);
}