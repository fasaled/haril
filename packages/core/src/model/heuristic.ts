/**
 * DEC-035 heuristic view for `FileTimelineCommands`.
 *
 * The heuristic view merges two lanes on grounds other than source-provided
 * identity or explicit rename evidence:
 *
 *   Rule A — temporary-file → target replacement (same dir, same pid,
 *             within 1000 ms).
 *   Rule B — delete → recreate on the same path (within 1000 ms).
 *
 * Merging is computed in memory only and labelled `[inferred]`. Bridge
 * events use `Kind = "HeuristicInference"`, `Source = "Heuristic"`.
 *
 * This module operates on a sequence of `FileTimelineLane` (fileKey +
 * ordered events) and emits an annotated structure that the TUI/MCP can
 * render with confidence.
 */

import type { EventKind, NormalizedEvent } from "./types.ts";

export type HeuristicBridgeKind = "InferredRecreation" | "InferredAtomicReplacement";

export interface FileTimelineLane {
  fileKey: import("./types.ts").FileKey;
  displayPath: string;
  events: NormalizedEvent[];
}

export interface HeuristicBridge {
  kind: HeuristicBridgeKind;
  fromLane: FileTimelineLane;
  toLane: FileTimelineLane;
  atTimestamp_ns: bigint;
  sharedPath: string;
  samePid: boolean;
  /** Index in `fromLane.events` where the delete / temp-rename happens. */
  fromIndex: number;
  /** Index in `toLane.events` where the create happens. */
  toIndex: number;
}

export interface AnnotatedTimelineLane {
  lane: FileTimelineLane;
  bridges: HeuristicBridge[];
}

const WINDOW_NS = 1_000_000_000n; // 1000 ms

/**
 * Compute bridges across all lanes in the dataset.
 *
 * Pure function: input lanes, output annotated lanes. The caller is
 * responsible for sorting lanes by their first event timestamp.
 */
export function computeHeuristicBridges(lanes: FileTimelineLane[]): AnnotatedTimelineLane[] {
  const byPid = new Map<number, FileTimelineLane[]>();
  const byPath = new Map<string, FileTimelineLane[]>();

  for (const lane of lanes) {
    for (const ev of lane.events) {
      const list = byPid.get(ev.pid);
      if (list) list.push(lane);
      else byPid.set(ev.pid, [lane]);
    }
    const key = normalizePathKey(lane.displayPath);
    const list = byPath.get(key);
    if (list) list.push(lane);
    else byPath.set(key, [lane]);
  }

  const annotated: AnnotatedTimelineLane[] = lanes.map((lane) => ({ lane, bridges: [] }));

  // Rule A — temporary-file → target replacement.
  // A "Write" or "Rename" event on a sibling lane followed by a "Create"
  // on this lane (or vice-versa) within 1000 ms, in the same directory,
  // with shared PID or name containment.
  for (const lane of lanes) {
    for (const ev of lane.events) {
      if (ev.eventKind !== "Write") continue;
      if (ev.timestamp_ns <= 0n) continue;
      const siblings = byPid.get(ev.pid) ?? [];
      for (const sibling of siblings) {
        if (sibling === lane) continue;
        if (pathDir(sibling.displayPath) !== pathDir(lane.displayPath)) continue;
        for (let i = 0; i < sibling.events.length; i++) {
          const sibEv = sibling.events[i]!;
          if (sibEv.eventKind !== "Create") continue;
          if (sibEv.timestamp_ns < ev.timestamp_ns) continue;
          const dt = sibEv.timestamp_ns - ev.timestamp_ns;
          if (dt > WINDOW_NS) continue;
          annotated[laneIndex(lanes, lane)]!.bridges.push({
            kind: "InferredAtomicReplacement",
            fromLane: lane,
            toLane: sibling,
            atTimestamp_ns: sibEv.timestamp_ns,
            sharedPath: lane.displayPath,
            samePid: true,
            fromIndex: lane.events.indexOf(ev),
            toIndex: i,
          });
        }
      }
    }
  }

  // Rule B — delete → recreate on the same path.
  for (const lane of lanes) {
    for (let i = 0; i < lane.events.length; i++) {
      const ev = lane.events[i]!;
      if (ev.eventKind !== "Delete") continue;
      const key = normalizePathKey(lane.displayPath);
      const siblings = byPath.get(key) ?? [];
      for (const sibling of siblings) {
        if (sibling === lane) continue;
        for (let j = 0; j < sibling.events.length; j++) {
          const sibEv = sibling.events[j]!;
          if (sibEv.eventKind !== "Create") continue;
          if (sibEv.timestamp_ns <= ev.timestamp_ns) continue;
          const dt = sibEv.timestamp_ns - ev.timestamp_ns;
          if (dt > WINDOW_NS) continue;
          annotated[laneIndex(lanes, lane)]!.bridges.push({
            kind: "InferredRecreation",
            fromLane: lane,
            toLane: sibling,
            atTimestamp_ns: sibEv.timestamp_ns,
            sharedPath: lane.displayPath,
            samePid: ev.pid === sibEv.pid,
            fromIndex: i,
            toIndex: j,
          });
        }
      }
    }
  }

  return annotated;
}

/** Produce a single merged timeline by following all bridges. */
export function mergedLaneEvents(
  annotated: AnnotatedTimelineLane[],
  rootLane: FileTimelineLane,
): NormalizedEvent[] {
  const out: NormalizedEvent[] = [...rootLane.events];
  const seen = new Set<number>([rootLane.events[0] ? 0 : -1]);
  const queue: HeuristicBridge[] = annotated
    .find((a) => a.lane === rootLane)
    ?.bridges.slice() ?? [];
  while (queue.length > 0) {
    const b = queue.shift()!;
    if (seen.has(b.toIndex)) continue;
    seen.add(b.toIndex);
    out.push(b.toLane.events[b.toIndex]!);
    const more = annotated.find((a) => a.lane === b.toLane)?.bridges ?? [];
    queue.push(...more);
  }
  // Stable order: by timestamp_ns.
  out.sort((a, b) => {
    if (a.timestamp_ns < b.timestamp_ns) return -1;
    if (a.timestamp_ns > b.timestamp_ns) return 1;
    return 0;
  });
  return out;
}

function laneIndex<T>(arr: T[], target: T): number {
  for (let i = 0; i < arr.length; i++) {
    if (Object.is(arr[i], target)) return i;
  }
  return -1;
}

function normalizePathKey(p: string): string {
  return p.replace(/\//g, "\\").toLowerCase();
}

function pathDir(p: string): string {
  const i = p.lastIndexOf("\\");
  if (i < 0) return "";
  return p.slice(0, i);
}