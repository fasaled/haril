/**
 * Real End-to-End Test: Live Capture with real file operations and analysis.
 *
 * Exercises the complete real workflow:
 * 1. Start live capture on a real directory in background mode.
 * 2. Perform live filesystem operations during capture:
 *    - create files
 *    - modify / append data
 *    - create subdirectories and copy files
 *    - rename files
 *    - delete files
 * 3. Verify live capture captures events and transitions automatically to analyze.
 * 4. Run real analysis queries (ls, events, evidence, summary, dirs, size-changes, search).
 */

import { describe, test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  unlinkSync,
  copyFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createSession, native, type FileActivitySummary } from "@haril-ts/core";

describe("live capture e2e with real file operations", () => {
  test(
    "captures real file lifecycle operations and enables full analysis",
    async () => {
      const watchedDir = mkdtempSync(join(tmpdir(), "haril-live-watch-"));
      const outputPackage = join(watchedDir, "output-capture.haril");

      // Seed an initial file before capture starts
      const initialFile = join(watchedDir, "pre-existing.txt");
      writeFileSync(initialFile, "Initial file contents before capture begins.\n");

      const session = await createSession({ phase: "empty" });

      const eventsLogged: string[] = [];
      session.onEvent((ev) => {
        if (ev.message) eventsLogged.push(ev.message);
      });

      // 1. Start live background capture (4 seconds window)
      const startRes = await session.run(
        `start-capture --root ${JSON.stringify(watchedDir)} --output ${JSON.stringify(outputPackage)} --seconds 4 --background`
      );
      expect(startRes.ok).toBe(true);
      expect(session.isCapturing).toBe(true);
      expect(session.snapshot().phase).toBe("live-capture");

      // Verify that starting a simultaneous capture is rejected
      const dupRes = await session.run(
        `start-capture --root ${JSON.stringify(watchedDir)} --output ${JSON.stringify(join(watchedDir, "dup.haril"))} --seconds 4 --background`
      );
      expect(dupRes.ok).toBe(false);
      expect(dupRes.error).toContain("capture already in progress");

      // 2. Perform real filesystem operations during the capture window
      await new Promise((r) => setTimeout(r, 400));

      // Operation A: Create a new file and write data
      const doc1 = join(watchedDir, "document1.txt");
      writeFileSync(doc1, "First line in document 1.\n");

      await new Promise((r) => setTimeout(r, 300));

      // Operation B: Append/modify the file
      appendFileSync(doc1, "Second line appended during capture.\n");

      await new Promise((r) => setTimeout(r, 300));

      // Operation C: Create subfolder and copy file
      const subDir = join(watchedDir, "subfolder");
      mkdirSync(subDir);
      const subFile = join(subDir, "document-copy.txt");
      copyFileSync(doc1, subFile);

      await new Promise((r) => setTimeout(r, 300));

      // Operation D: Create and rename a file
      const toRename = join(watchedDir, "original-name.txt");
      writeFileSync(toRename, "This file will be renamed.\n");
      await new Promise((r) => setTimeout(r, 200));
      const renamed = join(watchedDir, "final-name.txt");
      renameSync(toRename, renamed);

      await new Promise((r) => setTimeout(r, 300));

      // Operation E: Create and delete a temporary file
      const tempFile = join(watchedDir, "temp-file.tmp");
      writeFileSync(tempFile, "Temporary content to be deleted.\n");
      await new Promise((r) => setTimeout(r, 200));
      unlinkSync(tempFile);

      // Operation F: file under a >260-char path (long-path support)
      const longDir = join(watchedDir, ...Array.from({ length: 10 }, (_, i) => `long-path-segment-number-${i}`));
      mkdirSync("\\\\?\\" + longDir, { recursive: true });
      const longFile = join(longDir, "long-file.txt");
      writeFileSync("\\\\?\\" + longFile, "Lives under a path longer than MAX_PATH.\n");
      expect(longFile.length).toBeGreaterThan(260);

      // Live view: while the window is still open, created files and their
      // events must already be visible to the TUI (no wait for the end).
      await new Promise((r) => setTimeout(r, 300));
      expect(session.isCapturing).toBe(true);
      const live = session.liveState();
      expect(live).not.toBeNull();
      expect(live!.root).toBe(watchedDir);
      expect(live!.totalEvents).toBeGreaterThan(0);
      const livePaths = live!.files.map((f) => f.path.toLowerCase());
      expect(livePaths).toContain("\\pre-existing.txt");
      expect(livePaths).toContain("\\document1.txt");
      expect(live!.events.some((e) => e.path?.toLowerCase() === "\\document1.txt")).toBe(true);

      // 3. Wait for background capture to finish and finalize package
      await session.waitForActiveCapture();

      // Verify automatic transition to analyze phase
      expect(session.isCapturing).toBe(false);
      expect(session.snapshot().phase).toBe("analyze");
      expect(existsSync(outputPackage)).toBe(true);

      // Verify that capture-complete event was emitted
      expect(eventsLogged.some((m) => m.includes("capture complete"))).toBe(true);

      // Verify that when running elevated with native addon, kernel sources are active and not degraded
      const lib = native();
      if (lib && lib.isAdmin() === 1) {
        const snap = session.snapshot();
        expect(snap.sourceStatus.etw).toBe(true);
        expect(snap.sourceStatus.usn).toBe(true);
        expect(snap.sourceStatus.fsw).toBe(true);
        expect(snap.packageManifest?.sources.etw.available).toBe(true);
        expect(snap.packageManifest?.sources.usn.available).toBe(true);
        expect(snap.packageManifest?.sources.etw.eventsObserved).toBeGreaterThan(0);
      }

      // 4. Run real analysis queries on the captured package

      // Query A: ls lists the observed files
      const lsRes = await session.run("ls");
      expect(lsRes.ok).toBe(true);
      const lsData = lsRes.data as { items: Array<{ path: string; eventCount: number; fileKeyHash: string }> };
      expect(lsData.items.length).toBeGreaterThanOrEqual(3);

      const paths = lsData.items.map((i) => i.path).filter(Boolean);
      // Verify our created files are present in the timeline
      expect(paths.some((p) => p.includes("document1.txt"))).toBe(true);
      expect(paths.some((p) => p.includes("final-name.txt") || p.includes("original-name.txt"))).toBe(true);

      // Elevated: kernel sources must attach real, attributed events to files.
      if (lib && lib.isAdmin() === 1) {
        expect(session.snapshot().packageManifest?.sources.usn.recordsRead).toBeGreaterThan(0);
        const longEntry = lsData.items.find((i) => i.path?.endsWith("long-file.txt"));
        expect(longEntry).toBeDefined();
        expect(longEntry!.path.length).toBeGreaterThan(260 - watchedDir.length);
        const doc = lsData.items.find((i) => i.path?.toLowerCase() === "\\document1.txt")!;
        const evRes = await session.run(`events ${doc.fileKeyHash}`);
        const evItems = (evRes.data as { items: Array<{ source: string; eventKind: string; processImageName: string | null }> }).items;
        const etw = evItems.filter((e) => e.source === "etw");
        expect(etw.some((e) => e.processImageName?.toLowerCase() === "bun.exe")).toBe(true);
        expect(etw.some((e) => e.eventKind === "Create")).toBe(true);
        expect(etw.some((e) => e.eventKind === "Write")).toBe(true);
        expect(evItems.some((e) => e.source === "usn")).toBe(true);
      }

      // Query B: overview reports session-wide stats
      const ovRes = await session.run("overview");
      expect(ovRes.ok).toBe(true);
      const ovData = ovRes.data as { totalFiles: number; totalEvents: number };
      expect(ovData.totalFiles).toBeGreaterThanOrEqual(3);
      expect(ovData.totalEvents).toBeGreaterThanOrEqual(1);

      // Query C: dirs lists the observed directories
      const dirsRes = await session.run("dirs");
      expect(dirsRes.ok).toBe(true);
      const dirsData = dirsRes.data as { items: Array<{ directory: string }> };
      expect(dirsData.items.some((d) => d.directory.includes("subfolder") || d.directory === "\\")).toBe(true);

      // Query D: events for document1.txt
      const doc1Entry = lsData.items.find((i) => i.path && i.path.includes("document1.txt"));
      if (doc1Entry) {
        const eventsRes = await session.run(`events ${doc1Entry.fileKeyHash}`);
        expect(eventsRes.ok).toBe(true);
        const eventsData = eventsRes.data as { items: Array<{ id: number; eventKind: string; timestampNs: number }> };
        expect(eventsData.items.length).toBeGreaterThanOrEqual(1);

        // Query E: evidence on the first event
        const firstEvent = eventsData.items[0]!;
        const firstEvRes = await session.run(`evidence ${doc1Entry.fileKeyHash} ${firstEvent.id}`);
        expect(firstEvRes.ok).toBe(true);
        const evDetail = firstEvRes.data as { eventKind: string; source: string };
        expect(evDetail.eventKind).toBeDefined();
        expect(["etw", "fsw", "usn"]).toContain(evDetail.source);

        // Query F: summary for document1.txt
        const summaryRes = await session.run(`summary ${doc1Entry.fileKeyHash}`);
        expect(summaryRes.ok).toBe(true);
        const sumData = summaryRes.data as FileActivitySummary;
        expect(sumData.eventCount).toBeGreaterThanOrEqual(1);
      }

      // Query G: size-changes reflects length deltas
      const sizeRes = await session.run("size-changes");
      expect(sizeRes.ok).toBe(true);

      // Query H: heuristics can be toggled on
      const heurRes = await session.run("heuristics on");
      expect(heurRes.ok).toBe(true);
      expect(session.snapshot().heuristicsEnabled).toBe(true);

      session.close();
    },
    30000
  );
});
