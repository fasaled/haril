/**
 * Import a `.haril` package into a fresh SQLite index, attached to the session.
 */

import { readPackage, readPackageManifest } from "../package/reader.ts";
import { SqliteStore } from "./sqlite.ts";
import { fileKeyHash } from "../model/fileKey.ts";
import type { InventoryEntry, Manifest, NormalizedEvent, UsnRecord, PathNotification } from "../model/types.ts";

export async function importPackageIntoStore(
  path: string,
  store: SqliteStore,
): Promise<Manifest> {
  // Validate manifest first; if it fails, abort without writing to the store.
  const manifest = await readPackageManifest(path);
  if (manifest.fsKind !== "ntfs") {
    throw new Error(`non-NTFS package rejected (fsKind=${manifest.fsKind})`);
  }
  if (manifest.schemaVersion !== 1) {
    throw new Error(`unsupported schemaVersion ${manifest.schemaVersion}`);
  }

  const contents = await readPackage(path);

  store.insertInventoryEntries(contents.inventory, true);
  store.insertInventoryEntries(contents.finalInventory, false);
  store.computeSizeChanges();
  store.setCoverage({
    startedAtNs: manifest.startedAt,
    etwEventsObserved: manifest.sources.etw.eventsObserved,
    etwEventsLost: manifest.sources.etw.eventsLost,
    usnRecordsRead: manifest.sources.usn.recordsRead,
    fswNotifications: manifest.sources.fsw.notifications,
  });
  store.finalizeCoverage({
    stoppedAtNs: manifest.stoppedAt,
    etwEventsLost: manifest.sources.etw.eventsLost,
    usnRecordsRead: manifest.sources.usn.recordsRead,
    fswNotifications: manifest.sources.fsw.notifications,
  });

  // Insert events directly via batched flush
  for (const ev of contents.events) {
    store.enqueueEvent(ev);
  }
  store.flush();

  let notifId = 1;
  for (const n of contents.notifications) {
    store.insertPathNotification(n, notifId++);
  }
  let usnId = 1;
  for (const u of contents.usn) {
    store.insertUsnRecord(u, usnId++);
  }

  return contents.manifest;
}