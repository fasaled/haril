/**
 * Native payload placeholder used by development and source builds.
 *
 * Distribution builds replace this module temporarily, bundle the available
 * native addons, and restore this file before exiting.
 */

export interface EmbeddedPayload {
  version: string;
  base64: string;
}

export const EMBEDDED_NATIVE_PAYLOADS: Partial<
  Record<"x64" | "arm64", EmbeddedPayload>
> = {};
