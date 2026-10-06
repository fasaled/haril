/**
 * Pure event-filtering logic shared between `App.tsx` and the unit suite.
 *
 * Extracting this from the React tree lets us assert edge cases (empty filter
 * object, `reset: true`, the order in which filters compose) without
 * having to mount the whole TUI.
 */

import type { NormalizedEvent, EventKind } from "../../../core/src/index.ts";

export interface EventFilter {
  kinds?: EventKind[];
  failedOnly?: boolean;
  pid?: number;
  process?: string;
  reset?: boolean;
}

/** Returns the subset of `events` that satisfies every active filter.
 *  - Filters compose with AND semantics: an event must pass all of them.
 *  - When `reset` is true, the filter is cleared and the full list is
 *    returned (this is what the `R` keyboard shortcut does in the TUI).
 *  - Unknown / unset filter keys are ignored, so an empty `{}` filter
 *    returns the input list unchanged. */
export function applyEventFilter(
  events: readonly NormalizedEvent[],
  filter: EventFilter | undefined,
): NormalizedEvent[] {
  if (!filter || filter.reset) return events.slice();

  let result: NormalizedEvent[] = events.slice();

  if (filter.kinds && filter.kinds.length > 0) {
    const allowed = new Set<EventKind>(filter.kinds);
    result = result.filter((e) => allowed.has(e.eventKind));
  }

  if (filter.failedOnly) {
    result = result.filter((e) => e.ntStatus !== null && e.ntStatus !== 0);
  }

  if (filter.pid != null) {
    const wanted = filter.pid;
    result = result.filter((e) => e.pid === wanted);
  }

  if (filter.process) {
    const needle = filter.process.toLowerCase();
    result = result.filter((e) =>
      e.processImageName?.toLowerCase().includes(needle),
    );
  }

  return result;
}

/** Clamps `selectedIndex` into `[0, length)` and returns the event at that
 *  position (or `null` when the list is empty). Pure function used by both
 *  the rendering reconciliation effect and the test suite. */
export function reconcileSelection(
  events: readonly NormalizedEvent[],
  selectedIndex: number,
): { index: number; event: NormalizedEvent | null } {
  if (events.length === 0) return { index: 0, event: null };
  const clamped = Math.max(0, Math.min(selectedIndex, events.length - 1));
  return { index: clamped, event: events[clamped] ?? null };
}