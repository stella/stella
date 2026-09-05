import { Result } from "better-result";

/**
 * The landing's clipboard writer: every `.astro` inline script copies through
 * this module, so the failure path is written once. `navigator.clipboard` is
 * absent outside a secure context and `writeText` rejects on a denied
 * permission, and the inline scripts used to await that call and then announce
 * a copy that never happened. Returns a `Result<void>`, so a caller shows its
 * copied state only when the result is not an error.
 *
 * `apps/web` has its own owner (`apps/web/src/lib/copy-to-clipboard.ts`):
 * an Astro island cannot import from another app, and the two apps ship
 * separate bundles.
 */
export const copyToClipboard = async (text: string) =>
  await Result.tryPromise(
    async () => await navigator.clipboard.writeText(text),
  );
