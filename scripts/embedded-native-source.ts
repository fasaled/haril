import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface EmbeddedPayload {
  version: string;
  base64: string;
}

export function createEmbeddedNativeSource(root: string): {
  source: string;
  architectures: string[];
} {
  const pkg = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as { version?: string };
  const version = pkg.version ?? "0.0.0";
  const binaries: Array<{ arch: "x64" | "arm64"; path: string }> = [
    {
      arch: "x64",
      path: join(root, "native", "out", "bin", "haril_native.node"),
    },
    {
      arch: "arm64",
      path: join(root, "native", "out", "bin-arm64", "haril_native.node"),
    },
  ];
  const payloads: Partial<Record<"x64" | "arm64", EmbeddedPayload>> = {};

  for (const binary of binaries) {
    if (!existsSync(binary.path)) continue;
    payloads[binary.arch] = {
      version,
      base64: readFileSync(binary.path).toString("base64"),
    };
  }

  return {
    architectures: Object.keys(payloads),
    source: `/**
 * Generated temporarily by scripts/build-distribution.ts.
 * Do not commit generated payloads.
 */

export interface EmbeddedPayload {
  version: string;
  base64: string;
}

export const EMBEDDED_NATIVE_PAYLOADS: Partial<Record<"x64" | "arm64", EmbeddedPayload>> = ${JSON.stringify(payloads, null, 2)};
`,
  };
}
