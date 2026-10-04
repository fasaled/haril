import { describe, test, expect } from "bun:test";
import {
  computeHeuristicBridges,
  mergedLaneEvents,
  type FileTimelineLane,
} from "../src/model/heuristic.ts";
import type { NormalizedEvent } from "../src/model/types.ts";

function makeEvent(opts: {
  ts: bigint;
  kind: NormalizedEvent["eventKind"];
  pid: number;
  path?: string;
  sourceIdx?: number;
}): NormalizedEvent {
  return {
    timestamp_ns: opts.ts,
    eventKind: opts.kind,
    fileKey: null,
    pid: opts.pid,
    tid: opts.pid,
    processImageName: "proc.exe",
    irpPtr: null,
    ntStatus: 0,
    observedPath: opts.path ?? null,
    byteOffset: null,
    byteLength: null,
    shareAccess: null,
    createOptions: null,
    createDisposition: null,
    source: "etw",
    sourceEventIndex: opts.sourceIdx ?? 0,
  };
}

describe("heuristic bridges", () => {
  test("computes Rule A: temporary file replacement in same dir within 1000ms", () => {
    const laneA: FileTimelineLane = {
      fileKey: { kind: "path", root: "C:\\data", path: "\\temp.tmp" },
      displayPath: "C:\\data\\temp.tmp",
      events: [
        makeEvent({ ts: 100_000_000n, kind: "Create", pid: 100, path: "C:\\data\\temp.tmp", sourceIdx: 1 }),
        makeEvent({ ts: 200_000_000n, kind: "Write", pid: 100, path: "C:\\data\\temp.tmp", sourceIdx: 2 }),
      ],
    };

    const laneB: FileTimelineLane = {
      fileKey: { kind: "path", root: "C:\\data", path: "\\final.dat" },
      displayPath: "C:\\data\\final.dat",
      events: [
        makeEvent({ ts: 300_000_000n, kind: "Create", pid: 100, path: "C:\\data\\final.dat", sourceIdx: 3 }),
      ],
    };

    const annotated = computeHeuristicBridges([laneA, laneB]);
    expect(annotated.length).toBe(2);

    const bridgeA = annotated[0]!.bridges;
    expect(bridgeA.length).toBe(1);
    expect(bridgeA[0]!.kind).toBe("InferredAtomicReplacement");
    expect(bridgeA[0]!.fromLane).toBe(laneA);
    expect(bridgeA[0]!.toLane).toBe(laneB);
    expect(bridgeA[0]!.samePid).toBe(true);
  });

  test("computes Rule B: delete then recreate on same path within 1000ms", () => {
    const lane1: FileTimelineLane = {
      fileKey: { kind: "path", root: "C:\\data", path: "\\file.txt" },
      displayPath: "C:\\data\\file.txt",
      events: [
        makeEvent({ ts: 100_000_000n, kind: "Delete", pid: 200, path: "C:\\data\\file.txt", sourceIdx: 1 }),
      ],
    };

    const lane2: FileTimelineLane = {
      fileKey: { kind: "path", root: "C:\\data", path: "\\file.txt" },
      displayPath: "C:\\data\\file.txt",
      events: [
        makeEvent({ ts: 400_000_000n, kind: "Create", pid: 200, path: "C:\\data\\file.txt", sourceIdx: 2 }),
      ],
    };

    const annotated = computeHeuristicBridges([lane1, lane2]);
    const bridges = annotated[0]!.bridges;
    expect(bridges.length).toBe(1);
    expect(bridges[0]!.kind).toBe("InferredRecreation");
    expect(bridges[0]!.fromLane).toBe(lane1);
    expect(bridges[0]!.toLane).toBe(lane2);
  });

  test("ignores events outside the 1000ms window", () => {
    const lane1: FileTimelineLane = {
      fileKey: { kind: "path", root: "C:\\data", path: "\\file.txt" },
      displayPath: "C:\\data\\file.txt",
      events: [
        makeEvent({ ts: 100_000_000n, kind: "Delete", pid: 200, path: "C:\\data\\file.txt", sourceIdx: 1 }),
      ],
    };

    const lane2: FileTimelineLane = {
      fileKey: { kind: "path", root: "C:\\data", path: "\\file.txt" },
      displayPath: "C:\\data\\file.txt",
      events: [
        // 1.5 seconds later (> 1000ms window)
        makeEvent({ ts: 1_600_000_000n, kind: "Create", pid: 200, path: "C:\\data\\file.txt", sourceIdx: 2 }),
      ],
    };

    const annotated = computeHeuristicBridges([lane1, lane2]);
    expect(annotated[0]!.bridges.length).toBe(0);
  });

  test("mergedLaneEvents merges linked lanes and sorts chronologically", () => {
    const ev1 = makeEvent({ ts: 100n, kind: "Create", pid: 10, sourceIdx: 1 });
    const ev2 = makeEvent({ ts: 200n, kind: "Write", pid: 10, sourceIdx: 2 });
    const ev3 = makeEvent({ ts: 300n, kind: "Create", pid: 10, sourceIdx: 3 });

    const laneA: FileTimelineLane = {
      fileKey: { kind: "path", root: "C:\\data", path: "\\temp.tmp" },
      displayPath: "C:\\data\\temp.tmp",
      events: [ev1, ev2],
    };

    const laneB: FileTimelineLane = {
      fileKey: { kind: "path", root: "C:\\data", path: "\\final.dat" },
      displayPath: "C:\\data\\final.dat",
      events: [ev3],
    };

    const annotated = computeHeuristicBridges([laneA, laneB]);
    const merged = mergedLaneEvents(annotated, laneA);

    expect(merged.length).toBe(3);
    expect(merged[0]!.timestamp_ns).toBe(100n);
    expect(merged[1]!.timestamp_ns).toBe(200n);
    expect(merged[2]!.timestamp_ns).toBe(300n);
  });
});
