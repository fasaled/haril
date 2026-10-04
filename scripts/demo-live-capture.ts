/**
 * Demonstrates a real live capture session with file copies, modifications,
 * renames and deletions, followed by real analysis queries.
 *
 * Run with:
 *   bun run scripts/demo-live-capture.ts
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  unlinkSync,
  copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSession } from "../packages/core/src/index.ts";

async function main(): Promise<void> {
  console.log("=== Haril Live Capture & Real Analysis Demo ===\n");

  const watchedDir = mkdtempSync(join(tmpdir(), "haril-demo-"));
  const outputPackage = join(watchedDir, "demo-session.haril");

  console.log(`1. Target directory: ${watchedDir}`);
  console.log(`   Output package:   ${outputPackage}\n`);

  // Initial file
  const initialFile = join(watchedDir, "README.txt");
  writeFileSync(initialFile, "Project Documentation\nCreated before capture.\n");
  console.log("✓ Created pre-existing file: README.txt");

  const session = await createSession({ phase: "empty" });

  session.onEvent((ev) => {
    console.log(`\n[EVENT] ${ev.message}`);
  });

  // Start background capture for 5 seconds
  console.log("\n2. Starting live capture in background (5 seconds)...");
  const startRes = await session.run(
    `start-capture --root ${JSON.stringify(watchedDir)} --output ${JSON.stringify(outputPackage)} --seconds 5 --background`
  );
  console.log(`   Status: ${startRes.ok ? "OK" : "ERROR"}`);
  console.log(`   Phase:  ${session.snapshot().phase}\n`);

  // Perform live file operations
  console.log("3. Performing live filesystem operations during capture:");

  await sleep(400);
  const dataFile = join(watchedDir, "data.csv");
  writeFileSync(dataFile, "id,name,value\n1,alpha,100\n");
  console.log("   [+Create] Created data.csv");

  await sleep(400);
  appendFileSync(dataFile, "2,beta,200\n3,gamma,300\n");
  console.log("   [~Modify] Appended rows to data.csv");

  await sleep(400);
  const subFolder = join(watchedDir, "backup");
  mkdirSync(subFolder);
  const copiedFile = join(subFolder, "data-backup.csv");
  copyFileSync(dataFile, copiedFile);
  console.log("   [+Folder/Copy] Copied data.csv -> backup/data-backup.csv");

  await sleep(400);
  const draftFile = join(watchedDir, "draft-notes.tmp");
  writeFileSync(draftFile, "Draft notes that will be promoted.\n");
  console.log("   [+Create] Created draft-notes.tmp");

  await sleep(300);
  const finalFile = join(watchedDir, "official-notes.txt");
  renameSync(draftFile, finalFile);
  console.log("   [➔Rename] Renamed draft-notes.tmp -> official-notes.txt");

  await sleep(400);
  const scratch = join(watchedDir, "scratch.tmp");
  writeFileSync(scratch, "Scratch file.\n");
  console.log("   [+Create] Created temporary scratch.tmp");

  await sleep(300);
  unlinkSync(scratch);
  console.log("   [✕Delete] Deleted scratch.tmp");

  console.log("\n4. Waiting for background capture to complete and build package...");
  await session.waitForActiveCapture();

  console.log(`\n✓ Active capture finished! Current phase: ${session.snapshot().phase.toUpperCase()}`);

  // Run real analysis commands
  console.log("\n5. Running real analysis commands:");

  console.log("\n--- A. Command: ls (Browse observed file timelines) ---");
  const lsRes = await session.run("ls");
  if (lsRes.ok && lsRes.kind === "json" && lsRes.data) {
    const items = (lsRes.data as any).items ?? [];
    for (const item of items) {
      console.log(`   📄 ${item.path || item.fileKeyHash} (${item.eventCount ?? 0} events)`);
    }
  }

  console.log("\n--- B. Command: overview (Session-wide totals) ---");
  const ovRes = await session.run("overview");
  if (ovRes.ok && ovRes.data) {
    const ov = ovRes.data as any;
    console.log(`   Total files observed:  ${ov.totalFiles}`);
    console.log(`   Total events captured: ${ov.totalEvents}`);
    if (ov.eventKindCounts) {
      console.log(`   Event counts by kind:  ${JSON.stringify(ov.eventKindCounts)}`);
    }
  }

  console.log("\n--- C. Command: dirs (Observed directories) ---");
  const dirsRes = await session.run("dirs");
  if (dirsRes.ok && dirsRes.data) {
    const items = (dirsRes.data as any).items ?? [];
    for (const d of items) {
      console.log(`   📁 ${d.directory} (${d.fileCount} files)`);
    }
  }

  // Find data.csv for detailed analysis
  const lsItems = (lsRes.data as any)?.items ?? [];
  const dataEntry = lsItems.find((i: any) => i.path && i.path.includes("data.csv"));
  if (dataEntry) {
    console.log(`\n--- D. Command: summary ${dataEntry.fileKeyHash} (Summary for data.csv) ---`);
    const sumRes = await session.run(`summary ${dataEntry.fileKeyHash}`);
    if (sumRes.ok && sumRes.data) {
      const s = sumRes.data as any;
      console.log(`   Events:     ${s.eventCount}`);
      console.log(`   Operations: ${JSON.stringify(s.operationCounts)}`);
    }

    console.log(`\n--- E. Command: events ${dataEntry.fileKeyHash} (Event timeline for data.csv) ---`);
    const evRes = await session.run(`events ${dataEntry.fileKeyHash}`);
    if (evRes.ok && evRes.data) {
      const items = (evRes.data as any).items ?? [];
      for (const ev of items.slice(0, 5)) {
        console.log(`   • [${ev.source?.toUpperCase()}] ${ev.eventKind} at ${ev.timestampNs ?? ev.timestamp_ns} ns`);
      }
    }
  }

  session.close();
  console.log("\n=== Demo completed successfully! ===");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
