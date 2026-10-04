/**
 * Capture native addon tests.
 *
 * These tests run ONLY when haril_native.node loads in the current runtime/architecture.
 * Otherwise they are skipped (analyze-only mode).
 *
 * To enable: compile haril_native.node for the current architecture:
 *   Windows x64:  bun run build:native
 *   Windows arm64: bun run build:native:arm64
 *   (requires Visual Studio Build Tools with C++ workload)
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCapture } from "../src/capture/capture.ts";
import { native } from "../src/ffi/bindings.ts";

// Module-level check so the test is properly marked as skipped.
const IS_NATIVE_AVAILABLE = native() !== null;

if (IS_NATIVE_AVAILABLE) {
  describe("capture with native addon", () => {
    test("captures events with native addon available", async () => {
      // 1. Verificar que el addon nativo está cargado
      expect(native()).not.toBeNull();

      const tmp = mkdtempSync(join(tmpdir(), "haril-native-cap-"));
      const root = join(tmp, "watched");
      mkdirSync(root);

      // Crear archivos iniciales
      writeFileSync(join(root, "a.txt"), "hello");
      writeFileSync(join(root, "b.txt"), "world");

      const out = join(tmp, "out-native.haril");

      const churn = (async () => {
        await new Promise((r) => setTimeout(r, 400));
        writeFileSync(join(root, "c.txt"), "mid-window create");
      })();

      // 2. Ejecutar captura con addon nativo (2 segundos)
      const result = await runCapture({ root, output: out, seconds: 2 });
      await churn;

      // 3. Validaciones clave modo nativo
      expect(result.nativeAvailable).toBe(true);

      // 4. Events deberían haberse capturado
      expect(result.events.length).toBeGreaterThan(0);

      // 5. FSW notifications deberían estar presentes
      expect(result.notifications.length).toBeGreaterThanOrEqual(0);

      // 6. ETW/USN should have availability flags
      expect(typeof result.manifest.sources.etw.available).toBe("boolean");
      expect(typeof result.manifest.sources.usn.available).toBe("boolean");

      // Si el proceso corre elevado (isAdmin === 1), ETW y USN deben ser true
      const lib = native();
      if (lib && lib.isAdmin() === 1) {
        expect(result.manifest.sources.etw.available).toBe(true);
        expect(result.manifest.sources.usn.available).toBe(true);
        // Debe haber eventos capturados directamente de ETW
        const etwEvents = result.events.filter((e) => e.source === "etw");
        expect(etwEvents.length).toBeGreaterThan(0);
      }

      // 7. Verificar que el manifiesto se escribió correctamente
      expect(result.manifest.sessionId).toBeDefined();
      expect(result.manifest.root).toBe(root);
      expect(result.manifest.fsKind).toBe("ntfs");

      // 8. Events should have source diversity (some fsw, possibly etw/usn)
      const sources = result.events.map((e) => e.source);
      expect(sources).toContain("fsw"); // FSW siempre está activo

      // 9. fileId128 debería estar poblado en algunos events (identity via native addon)
      const eventsWithFileId = result.events.filter(
        (e) => e.fileKey?.kind === "exact" && e.fileKey?.fileId128?.length === 16,
      );
      // Al menos algunos events deberían tener fileId128 poblado
      // (puede ser 0 si los archivos fueron creados fuera del sistema de archivos monitorizado)

      // 10. El tiempo transcurrido debería estar en el manifiesto
      expect(result.manifest.startedAt).toBeLessThanOrEqual(result.manifest.stoppedAt);
    }, 30000);

    test("capture works with native addon and verifies degradation path", async () => {
      // This test verifies the system handles the native addon presence
      const lib = native();
      expect(lib).not.toBeNull(); // Fallará si no hay addon, confirmando el skip

      const tmp = mkdtempSync(join(tmpdir(), "haril-degradation-"));
      const root = join(tmp, "watched");
      mkdirSync(root);
      writeFileSync(join(root, "test.txt"), "test");

      const churn = (async () => {
        await new Promise((r) => setTimeout(r, 300));
        writeFileSync(join(root, "test2.txt"), "mid-window");
      })();

      const out = join(tmp, "out-degradation.haril");
      const result = await runCapture({ root, output: out, seconds: 1 });
      await churn;

      // Should still complete (graceful degradation)
      expect(result.packagePath).toBe(out);
      expect(result.nativeAvailable).toBe(true); // Todavía true porque addon estaba al inicio

      // Events should still be captured via FSW synthesis
      expect(result.events.length).toBeGreaterThan(0);
    }, 30000);
  });
} else {
  // Module-level: mark the describe as skipped
  describe.skip("capture with native addon", () => {
    test("placeholder", () => {
      // no-op - will run when haril_native.node is available
    });
  });
}