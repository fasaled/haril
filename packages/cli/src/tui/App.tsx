import React, { useState, useEffect, useMemo, useRef } from "react";
import { Box, Text, useInput, useApp, useWindowSize } from "ink";
import type { HarilSession, SessionSnapshot, NormalizedEvent, EventKind, LiveCaptureState } from "../../../core/src/index.ts";
import { CommandQueue, parseCommand, type QueuedCommand } from "../../../core/src/index.ts";
import { Header } from "./components/Header.tsx";
import { Prompt, type OutputLine } from "./components/Prompt.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { HelpOverlay } from "./components/HelpOverlay.tsx";
import { KEYBOARD_HELP } from "./keys.ts";
import { FileBrowser, type FileItem } from "./components/FileBrowser.tsx";
import { EventList } from "./components/EventList.tsx";
import { EventDetail } from "./components/EventDetail.tsx";
import { LiveCapturePanel, filterLiveEvents } from "./components/LiveCapturePanel.tsx";

export interface AppProps {
  session: HarilSession;
}

export const App: React.FC<AppProps> = ({ session }) => {
  const { exit } = useApp();
  const { rows, columns } = useWindowSize();
  const termRows = rows || process.stdout.rows || 24;
  const termCols = columns || process.stdout.columns || 80;

  // Core state
  const [snap, setSnap] = useState<SessionSnapshot>(() => session.snapshot());

  // Command queue & background task state (sailkari style)
  const commandQueueRef = useRef(new CommandQueue());
  const [queueEntries, setQueueEntries] = useState<readonly QueuedCommand[]>([]);
  const [activeTask, setActiveTask] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  // Terminal output stream state (inside Prompt section)
  const [terminalLines, setTerminalLines] = useState<OutputLine[]>([
    {
      id: "init",
      text: "Ready. Type `help` to see commands, or `open <path.haril>` to analyze.",
      tone: "muted",
    },
  ]);
  const [terminalScrollOffset, setTerminalScrollOffset] = useState(0);

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
  const [eventFilter, setEventFilter] = useState<{
    kinds?: EventKind[];
    failedOnly?: boolean;
    pid?: number;
    process?: string;
    reset?: boolean;
  }>({});

  // UI state
  const [helpOpen, setHelpOpen] = useState(false);
  const [focusedPanel, setFocusedPanel] = useState<"files" | "events" | "detail" | "prompt">("prompt");

  // Live capture state (streamed from the background capture)
  const [live, setLive] = useState<LiveCaptureState | null>(null);
  const [liveSelectedPath, setLiveSelectedPath] = useState<string | null>(null);
  const [liveScroll, setLiveScroll] = useState(0);

  const addTerminalOutput = (text: string, tone?: OutputLine["tone"]) => {
    const rawLines = text.split("\n");
    const newItems: OutputLine[] = rawLines.map((line, idx) => {
      let determinedTone: OutputLine["tone"] = tone ?? "default";
      if (line.startsWith("✓") || line.includes("complete:")) determinedTone = "success";
      else if (line.startsWith("!") || line.startsWith("warning") || line.startsWith("note:")) determinedTone = "warning";
      else if (line.startsWith("error:") || line.startsWith("failed")) determinedTone = "error";
      else if (line.startsWith("{") || line.startsWith("}") || line.startsWith("  \"")) determinedTone = "info";
      return {
        id: `${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
        text: line.length > 0 ? line : " ",
        tone: determinedTone,
      };
    });
    setTerminalLines((cur) => [...cur, ...newItems].slice(-500));
    setTerminalScrollOffset(0);
  };

  const handleTerminalScroll = (
    direction: "up" | "down" | "pageUp" | "pageDown" | "first" | "last"
  ) => {
    setTerminalScrollOffset((cur) => {
      switch (direction) {
        case "up":
          return cur + 1;
        case "down":
          return Math.max(0, cur - 1);
        case "pageUp":
          return cur + 4;
        case "pageDown":
          return Math.max(0, cur - 4);
        case "first":
          return 9999;
        case "last":
          return 0;
      }
    });
  };

  // Listen to background session events (e.g. background capture completion)
  useEffect(() => {
    const unsubscribe = session.onEvent((ev) => {
      if (ev.message) {
        addTerminalOutput(ev.message, ev.ok ? "success" : "error");
      }
      if (ev.type === "capture-started") {
        setLiveSelectedPath(null);
        setLiveScroll(0);
        setLive(session.liveState());
      }
      if (ev.type === "capture-complete") {
        setSelectedFileKeyHash(null);
        setSelectedFileIndex(0);
        setFiles([]);
        setEvents([]);
        setSelectedEvent(null);
      }
      setSnap(session.snapshot());
      if (session.snapshot().phase === "analyze") {
        void loadFiles(true);
      }
    });
    return unsubscribe;
  }, [session]);

  // Stream live capture updates (throttled; skips re-render when unchanged)
  useEffect(() => {
    if (snap.phase !== "live-capture") return;
    const tick = () => {
      const next = session.liveState();
      setLive((cur) => (cur?.version === next?.version ? cur : next));
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [snap.phase, session]);

  const liveFileItems = useMemo<FileItem[]>(() => {
    const items: FileItem[] = [{ fileKeyHash: "*", display: "(all)", path: null }];
    for (const f of live?.files ?? []) {
      items.push({ fileKeyHash: f.path, path: f.path, eventCount: f.eventCount });
    }
    return items;
  }, [live?.version]);

  const handleLiveFileNavigate = (
    direction: "left" | "right" | "first" | "last" | "up" | "down" | "pageUp" | "pageDown"
  ) => {
    const cur = Math.max(0, liveFileItems.findIndex((f) => (f.path ?? null) === liveSelectedPath));
    let next = cur;
    if (direction === "left" || direction === "up") next = Math.max(0, cur - 1);
    else if (direction === "right" || direction === "down") next = Math.min(liveFileItems.length - 1, cur + 1);
    else if (direction === "first") next = 0;
    else if (direction === "last") next = liveFileItems.length - 1;
    else if (direction === "pageUp") next = Math.max(0, cur - 10);
    else if (direction === "pageDown") next = Math.min(liveFileItems.length - 1, cur + 10);
    setLiveSelectedPath(liveFileItems[next]?.path ?? null);
    setLiveScroll(0);
  };

  // Global key handling
  useInput((input, key) => {
    if (key.ctrl && input === "q") {
      exit();
      return;
    }
    if (input === "?" && focusedPanel !== "prompt") {
      setHelpOpen((v) => !v);
      return;
    }
    if (input === ":" || input === "\\") {
      setFocusedPanel("prompt");
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

    if (key.escape) {
      if (helpOpen) {
        setHelpOpen(false);
        return;
      }
      if (focusedPanel !== "prompt") {
        setFocusedPanel("prompt");
        return;
      }
    }

    // Panel switching with Tab when not typing in prompt
    if (key.tab && focusedPanel !== "prompt") {
      const order = ["files", "events", "detail", "prompt"] as const;
      const curIdx = order.indexOf(focusedPanel);
      const nextIdx = (curIdx + 1) % order.length;
      setFocusedPanel(order[nextIdx]!);
      return;
    }

    // Panel-specific keys. EventList/FileBrowser handle their own input in
    // analyze; the live event stream is scrolled here.
    if (focusedPanel === "events" && snap.phase === "live-capture") {
      const total = filterLiveEvents(live?.events ?? [], liveSelectedPath).length;
      const page = Math.max(1, mainContentLines - 3);
      const clamp = (v: number) => Math.max(0, Math.min(Math.max(0, total - page), v));
      if (key.upArrow) setLiveScroll((s) => clamp(s + 1));
      if (key.downArrow) setLiveScroll((s) => clamp(s - 1));
      if (key.pageUp) setLiveScroll((s) => clamp(s + page));
      if (key.pageDown) setLiveScroll((s) => clamp(s - page));
      if (key.home) setLiveScroll(clamp(total));
      if (key.end) setLiveScroll(0);
      return;
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

  // Update snapshot periodically
  useEffect(() => {
    setSnap(session.snapshot());
    const interval = setInterval(() => setSnap(session.snapshot()), 500);
    return () => clearInterval(interval);
  }, [session]);

  // Load files when entering analyze phase
  useEffect(() => {
    if (snap.phase === "analyze" && files.length === 0) {
      void loadFiles();
    }
  }, [snap.phase, session]);

  // File navigation handlers
  const handleFileNavigate = (
    direction: "left" | "right" | "first" | "last" | "up" | "down" | "pageUp" | "pageDown"
  ) => {
    const filtered = getFilteredFiles();
    if (filtered.length === 0) return;

    let newIndex = selectedFileIndex;
    switch (direction) {
      case "left":
      case "up":
        newIndex = Math.max(0, selectedFileIndex - 1);
        break;
      case "right":
      case "down":
        newIndex = Math.min(filtered.length - 1, selectedFileIndex + 1);
        break;
      case "first":
        newIndex = 0;
        break;
      case "last":
        newIndex = filtered.length - 1;
        break;
      case "pageUp":
        newIndex = Math.max(0, selectedFileIndex - 10);
        break;
      case "pageDown":
        newIndex = Math.min(filtered.length - 1, selectedFileIndex + 10);
        break;
    }
    setSelectedFileIndex(newIndex);

    const entry = filtered[newIndex];
    if (entry) {
      setSelectedFileKeyHash(entry.fileKeyHash);
      void loadEventsForKey(entry.fileKeyHash);
    }
  };

  const handleEventNavigate = (direction: "up" | "down" | "first" | "last" | "pageUp" | "pageDown") => {
    const filtered = getFilteredEvents();
    if (filtered.length === 0) return;

    let newIndex = selectedEventIndex;
    switch (direction) {
      case "up":
        newIndex = Math.max(0, selectedEventIndex - 1);
        break;
      case "down":
        newIndex = Math.min(filtered.length - 1, selectedEventIndex + 1);
        break;
      case "first":
        newIndex = 0;
        break;
      case "last":
        newIndex = filtered.length - 1;
        break;
      case "pageUp":
        newIndex = Math.max(0, selectedEventIndex - 15);
        break;
      case "pageDown":
        newIndex = Math.min(filtered.length - 1, selectedEventIndex + 15);
        break;
    }
    setSelectedEventIndex(newIndex);
    setSelectedEvent(filtered[newIndex] || null);
  };

  const getFilteredFiles = () => files;

  const getFilteredEvents = () => {
    let result = events;
    if (eventFilter.kinds?.length) {
      result = result.filter((e) => eventFilter.kinds!.includes(e.eventKind));
    }
    if (eventFilter.failedOnly) {
      result = result.filter((e) => e.ntStatus !== null && e.ntStatus !== 0);
    }
    if (eventFilter.pid != null) {
      result = result.filter((e) => e.pid === eventFilter.pid);
    }
    if (eventFilter.process) {
      const lower = eventFilter.process.toLowerCase();
      result = result.filter((e) => e.processImageName?.toLowerCase().includes(lower));
    }
    if (eventFilter.reset) {
      return events;
    }
    return result;
  };

  const loadFiles = async (reset = false) => {
    setFileLoading(true);
    try {
      const result = await session.runCommand(parseCommand("ls --limit 1000"));
      if (result.ok && result.kind === "json" && result.data && typeof result.data === "object") {
        const items: FileItem[] = Array.isArray(result.data)
          ? (result.data as any)
          : (result.data as any).items ?? [];
        setFiles(items);
        if (items.length > 0 && (reset || !selectedFileKeyHash)) {
          const entry = items[0]!;
          setSelectedFileIndex(0);
          setSelectedFileKeyHash(entry.fileKeyHash);
          void loadEventsForKey(entry.fileKeyHash);
        } else if (items.length === 0) {
          setSelectedFileKeyHash(null);
          setEvents([]);
          setSelectedEvent(null);
        }
      }
    } catch (e) {
      console.error("loadFiles error:", e);
    } finally {
      setFileLoading(false);
    }
  };

  const loadEventsForKey = async (target: string) => {
    setSelectedEvent(null);
    setSelectedEventIndex(0);
    setEventsLoading(true);
    try {
      const result = await session.runCommand(parseCommand(`events ${target} --limit 1000`));
      if (result.ok && result.kind === "json" && result.data && typeof result.data === "object") {
        const items: NormalizedEvent[] = Array.isArray(result.data)
          ? (result.data as any)
          : (result.data as any).items ?? [];
        setEvents(items);
        setSelectedEventIndex(0);
        setSelectedEvent(null);
      }
    } catch (e) {
      console.error("loadEvents error:", e);
    } finally {
      setEventsLoading(false);
    }
  };

  // Command queue processing (sailkari model)
  const processQueue = async () => {
    if (busyRef.current) return;
    const next = commandQueueRef.current.dequeue();
    setQueueEntries([...commandQueueRef.current.entries()]);
    if (!next) return;

    busyRef.current = true;
    setBusy(true);
    setActiveTask(next.input);

    try {
      addTerminalOutput(`❯ ${next.input}`, "cmd");

      // For start-capture, execute in background mode so the UI thread is never blocked
      let runLine = next.input;
      if (runLine.startsWith("start-capture") && !runLine.includes("--background") && !runLine.includes("--bg")) {
        runLine += " --background";
      }

      const result = await session.run(runLine);
      let text = formatResult(result);
      if (result.ok && /^help\b/i.test(next.input.trim())) {
        text = `Commands\n${text.replace(/^/gm, "  ")}\n\n${KEYBOARD_HELP}`;
      }
      addTerminalOutput(text, result.ok ? "default" : "error");

      if ((result.data as any)?.action === "quit") {
        exit();
        return;
      }
      if ((result.data as any)?.action === "open-analyze") {
        setSnap(session.snapshot());
        await loadFiles(true);
      }
      if ((result.data as any)?.action === "cd") {
        await loadFiles(true);
      }
      if ((result.data as any)?.action === "close") {
        setSelectedFileKeyHash(null);
        setFiles([]);
        setEvents([]);
        setSelectedEvent(null);
      }
      setSnap(session.snapshot());
    } catch (err) {
      addTerminalOutput(err instanceof Error ? err.message : String(err), "error");
    } finally {
      busyRef.current = false;
      setBusy(false);
      setActiveTask(null);
      // Process next queued command asynchronously
      void processQueue();
    }
  };

  // Prompt submit handler
  const onPromptSubmit = async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const tokens = trimmed.split(/\s+/);
    const cmd = tokens[0]!.toLowerCase();

    // Immediate queue management commands
    if (cmd === "queue") {
      const sub = tokens[1]?.toLowerCase();
      if (!sub || sub === "show") {
        const entries = commandQueueRef.current.entries();
        addTerminalOutput(
          entries.length
            ? `Queued commands (${entries.length}):\n` +
                entries.map((entry, index) => `  ${index + 1}. ${entry.input}`).join("\n")
            : "Queue is empty.",
          "info"
        );
      } else if (sub === "clear") {
        const count = commandQueueRef.current.clear();
        setQueueEntries([]);
        addTerminalOutput(`Cleared ${count} queued command(s).`, "info");
      } else if (sub === "remove") {
        const pos = parseInt(tokens[2] ?? "", 10);
        const removed = commandQueueRef.current.remove(pos);
        setQueueEntries([...commandQueueRef.current.entries()]);
        addTerminalOutput(
          removed ? `Removed from queue: ${removed.input}` : "Invalid queue position.",
          removed ? "info" : "error"
        );
      } else if (sub === "move") {
        const from = parseInt(tokens[2] ?? "", 10);
        const to = parseInt(tokens[3] ?? "", 10);
        const ok = commandQueueRef.current.move(from, to);
        setQueueEntries([...commandQueueRef.current.entries()]);
        addTerminalOutput(ok ? "Queue reordered." : "Invalid queue positions.", ok ? "info" : "error");
      }
      return;
    }

    if (cmd === "cancel") {
      if (session.isCapturing) {
        addTerminalOutput("❯ cancel", "cmd");
        const res = await session.run("stop-capture");
        addTerminalOutput(formatResult(res), "warning");
      } else {
        const cleared = commandQueueRef.current.clear();
        setQueueEntries([]);
        addTerminalOutput(cleared > 0 ? `Cancelled ${cleared} queued command(s).` : "No active task to cancel.", "info");
      }
      return;
    }

    // Enqueue command and start processor
    commandQueueRef.current.enqueue(trimmed);
    setQueueEntries([...commandQueueRef.current.entries()]);
    void processQueue();
  };

  // UI hint
  const hint = useMemo(() => {
    if (snap.phase === "empty")
      return "open <path.haril> | start-capture [--root <dir>] [--output <file.haril>] [--seconds <n>]";
    if (snap.phase === "live-capture") return "stop-capture | force-quit-capture";
    return `package: ${snap.packagePath ?? "?"} — close`;
  }, [snap]);

  // Terminal Prompt panel height: comfortable terminal window (8 to 11 lines)
  const promptHeight = Math.max(8, Math.min(11, Math.floor(termRows * 0.35)));
  const mainContentLines = Math.max(5, termRows - 5 - promptHeight);

  // Phase-specific render functions
  function renderEmptyPhase() {
    return (
      <Box flexDirection="column" width={termCols} height={termRows} paddingX={1} overflow="hidden">
        <Header snapshot={snap} />
        <Box
          flexDirection="column"
          flexGrow={1}
          minHeight={0}
          borderStyle="round"
          borderColor="gray"
          paddingX={2}
          justifyContent="center"
          alignItems="center"
        >
          <Text dimColor>No package loaded</Text>
        </Box>

        <StatusBar snapshot={snap} />

        {/* Terminal Prompt with integrated scrollable output and queue */}
        <Prompt
          hint=""
          history={session.history() as string[]}
          phase={snap.phase}
          session={session}
          onSubmit={onPromptSubmit}
          isFocused={focusedPanel === "prompt"}
          width={termCols - 2}
          height={promptHeight}
          terminalLines={terminalLines}
          onTerminalScroll={handleTerminalScroll}
          terminalScrollOffset={terminalScrollOffset}
          queueCount={queueEntries.length}
          activeTask={activeTask}
        />
        {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
      </Box>
    );
  }

  function renderLiveCapturePhase() {
    return (
      <Box flexDirection="column" width={termCols} height={termRows} paddingX={1} overflow="hidden">
        <Header snapshot={snap} />
        <FileBrowser
          entries={liveFileItems}
          selectedKeyHash={liveSelectedPath ?? "*"}
          onSelect={(entry) => {
            setLiveSelectedPath(entry.path ?? null);
            setLiveScroll(0);
          }}
          onNavigate={handleLiveFileNavigate}
          isFocused={focusedPanel === "files"}
          filter={{}}
          loading={false}
          width={termCols - 2}
        />
        <Box flexDirection="column" flexGrow={1} minHeight={0}>
          <LiveCapturePanel
            live={live}
            selectedPath={liveSelectedPath}
            isFocused={focusedPanel === "events"}
            scrollOffset={liveScroll}
            height={Math.max(4, mainContentLines - 1)}
          />
        </Box>

        <StatusBar snapshot={snap} />

        {/* Terminal Prompt with integrated scrollable output and queue */}
        <Prompt
          hint=""
          history={session.history() as string[]}
          phase={snap.phase}
          session={session}
          onSubmit={onPromptSubmit}
          isFocused={focusedPanel === "prompt"}
          width={termCols - 2}
          height={promptHeight}
          terminalLines={terminalLines}
          onTerminalScroll={handleTerminalScroll}
          terminalScrollOffset={terminalScrollOffset}
          queueCount={queueEntries.length}
          activeTask={activeTask}
        />
        {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
      </Box>
    );
  }

  function renderAnalyzePhase() {
    return (
      <Box flexDirection="column" width={termCols} height={termRows} paddingX={1} overflow="hidden">
        <Header snapshot={snap} />

        {/* Horizontal File Selector Bar spanning full width */}
        <FileBrowser
          entries={files}
          selectedKeyHash={selectedFileKeyHash}
          onSelect={(entry) => {
            setSelectedFileKeyHash(entry.fileKeyHash);
            void loadEventsForKey(entry.fileKeyHash);
          }}
          onNavigate={handleFileNavigate}
          isFocused={focusedPanel === "files"}
          filter={{}}
          loading={fileLoading}
          width={termCols - 2}
        />

        {/* Main Content Area: Side-by-side EventList and EventDetail */}
        <Box flexDirection="row" flexGrow={1} minHeight={0} overflow="hidden">
          <Box width="60%" height="100%">
            {selectedFileKeyHash ? (
              <EventList
                events={events}
                baseNs={snap.packageManifest?.startedAt}
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
                visibleHeight={mainContentLines}
              />
            ) : (
              <Box
                borderStyle="round"
                borderColor="gray"
                width="100%"
                height="100%"
                paddingX={2}
                paddingY={1}
                justifyContent="center"
                alignItems="center"
              >
                <Text dimColor>Select a file from the horizontal selector above to view its timeline events</Text>
              </Box>
            )}
          </Box>
          <Box width="40%" height="100%">
            <EventDetail
              event={selectedEvent}
              baseNs={snap.packageManifest?.startedAt}
              fileKey={null}
              isFocused={focusedPanel === "detail"}
              onClose={() => {
                setSelectedEvent(null);
                setSelectedEventIndex(0);
                setFocusedPanel("prompt");
              }}
            />
          </Box>
        </Box>

        <StatusBar snapshot={snap} />

        {/* Terminal Prompt with integrated scrollable output and queue */}
        <Prompt
          hint=""
          history={session.history() as string[]}
          phase={snap.phase}
          session={session}
          onSubmit={onPromptSubmit}
          isFocused={focusedPanel === "prompt"}
          width={termCols - 2}
          height={promptHeight}
          terminalLines={terminalLines}
          onTerminalScroll={handleTerminalScroll}
          terminalScrollOffset={terminalScrollOffset}
          queueCount={queueEntries.length}
          activeTask={activeTask}
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