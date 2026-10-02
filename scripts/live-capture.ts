// Real elevated capture test: churn files while runCapture runs.
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCapture } from "../packages/core/src/capture/capture.ts";
import { readPackage } from "../packages/core/src/package/reader.ts";

const tmp = mkdtempSync(join(tmpdir(), "haril-live-"));
const root = join(tmp, "watched");
mkdirSync(root, { recursive: true });
writeFileSync(join(root, "seed.txt"), "seed");
const out = join(tmp, "live.haril");

let stop = false;
let n = 0;
const churn = (async () => {
  while (!stop) {
    n++;
    const f = join(root, `churn-${n}.txt`);
    writeFileSync(f, `data-${n}`);
    appendFileSync(f, "-more");
    if (n % 3 === 0) renameSync(f, join(root, `renamed-${n}.txt`));
    if (n % 5 === 0) rmSync(f, { force: true });
    await new Promise((r) => setTimeout(r, 150));
  }
})();

console.log("capturing 8s...");
const result = await runCapture({ root, output: out, seconds: 8 });
stop = true;
await churn;

console.log("events:", result.events.length, "| notifs:", result.notifications.length);
console.log("sources:", JSON.stringify(result.manifest.sources, null, 1));

const pkg = await readPackage(out);
console.log("package re-read ok:",
  `events=${pkg.events.length} inv=${pkg.inventory.length}/${pkg.finalInventory.length} usn=${pkg.usn.length}`);

const bySource: Record<string, number> = {};
for (const e of pkg.events) bySource[e.source] = (bySource[e.source] ?? 0) + 1;
console.log("events by source:", JSON.stringify(bySource));
const kinds: Record<string, number> = {};
for (const e of pkg.events) kinds[e.eventKind] = (kinds[e.eventKind] ?? 0) + 1;
console.log("events by kind:", JSON.stringify(kinds));

// FILE_ID continuity: every exact-keyed event should match an inventory row.
const invIds = new Set(pkg.inventory.map((i) =>
  i.fileId128 ? [...i.fileId128].map((b) => b.toString(16).padStart(2, "0")).join("") : ""));
let matched = 0, exactTotal = 0;
for (const e of pkg.events) {
  const k = e.fileKey as { kind: string; fileId128?: number[] | Uint8Array } | null;
  if (k?.kind === "exact" && k.fileId128) {
    exactTotal++;
    const hex = [...k.fileId128].map((b: number) => b.toString(16).padStart(2, "0")).join("");
    if (invIds.has(hex)) matched++;
  }
}
console.log(`exact-keyed events: ${exactTotal}, matching inventory identity: ${matched}`);
console.log("DONE", out);
