import { Result } from "better-result";

/**
 * Copy text to the system clipboard, wrapping the failable
 * `navigator.clipboard.writeText` in a Result so callers handle the
 * rejection path (denied permission, insecure context) without a bespoke
 * try/catch. Returns a `Result<void>`; inspect it with `Result.isError`.
 */
export const copyToClipboard = (text: string) =>
  Result.tryPromise(() => navigator.clipboard.writeText(text));
