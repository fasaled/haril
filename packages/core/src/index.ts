/**
 * Public API of `@haril-ts/core`.
 */

export * from "./model/types.ts";
export * from "./model/fileKey.ts";

export { SqliteStore } from "./store/sqlite.ts";
export type {
  BrowseFileTimelineRow,
  DirectoryEntry,
  EventRow,
  FileActivitySummary,
  SessionOverview,
  StoreConfig,
} from "./store/sqlite.ts";

export { importPackageIntoStore } from "./store/import.ts";

export { writePackage } from "./package/writer.ts";
export type { PackageInput } from "./package/writer.ts";
export { readPackage, readPackageManifest } from "./package/reader.ts";
export type { PackageContents } from "./package/reader.ts";

export { parseCommand, formatCommand } from "./commands/parse.ts";
export type { ParsedCommand } from "./commands/parse.ts";
export { complete, KNOWN_COMMANDS, FLAG_VALUES } from "./commands/complete.ts";
export type {
  Completion,
  CompleteContext,
  CompletionKind,
} from "./commands/complete.ts";

export { FileTimelineCommands, FILE_TIMELINE_PAGE_SIZE, FILE_TIMELINE_EVENTS_PER_FILE } from "./commands/file_timeline.ts";

export { HarilSession, createSession, bindSession } from "./session.ts";
export type { SessionSnapshot, StartCaptureArgs } from "./session.ts";

export { limits } from "./limits.ts";

export { native, requireNative, ensureExtractedNative, getExtractedNativeDir } from "./ffi/bindings.ts";
export type { NativeBindings, NativeInventoryRow, NativeFileId } from "./ffi/bindings.ts";
export { ringConsumer, drainOnce, decodeSlots, decodeSlot, SLOT_SIZE } from "./ffi/ring_consumer.ts";
export type { RingConsumer, DecodedSlot, UsnSlotIdentity } from "./ffi/ring_consumer.ts";