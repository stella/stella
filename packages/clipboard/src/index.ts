import { Result } from "better-result";

/**
 * Copy text to the system clipboard, wrapping the failable
 * `navigator.clipboard.writeText` in a Result so callers handle the
 * rejection path (denied permission, insecure context) without a bespoke
 * try/catch. Returns a `Result<void>`; inspect it with `Result.isError`.
 *
 * One implementation for every browser surface: `apps/web` reports the failure
 * with a toast and error capture, the `apps/landing` inline scripts leave the
 * copy button in its idle state, and neither reimplements the call.
 */
export const copyToClipboard = async (text: string) =>
  await Result.tryPromise(
    async () => await navigator.clipboard.writeText(text),
  );

type RichClipboardContent = {
  html: string;
  plain: string;
};

/** Writes interoperable rich text, retaining the plain-text representation. */
export const copyRichToClipboard = async ({
  html,
  plain,
}: RichClipboardContent) => {
  if (
    typeof globalThis.ClipboardItem !== "function" ||
    typeof navigator.clipboard?.write !== "function"
  ) {
    return await copyToClipboard(plain);
  }

  const richResult = await Result.tryPromise(
    async () =>
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" }),
        }),
      ]),
  );
  return Result.isError(richResult) ? await copyToClipboard(plain) : richResult;
};
