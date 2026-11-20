// `--save <path>` (`-o`) on a generated capability command: a capability that
// answers with a short-lived `downloadUrl` (an export, a rendered document)
// hands the URL over instead of the bytes, so the CLI fetches it and writes
// the file where the caller asked. The server's JSON answer is still printed;
// the file is the extra step a person would otherwise do by hand.

import { Result } from "better-result";
import { writeFile } from "node:fs/promises";

/** How long one download may take before the save gives up. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The download URL a capability result carries: top-level `downloadUrl`, or
 * `download.downloadUrl` for results that group the link with its expiry.
 */
export const readDownloadUrl = (payload: unknown): string | undefined => {
  if (!isRecord(payload)) {
    return undefined;
  }
  const direct = payload["downloadUrl"];
  if (typeof direct === "string") {
    return direct;
  }
  const grouped = payload["download"];
  return isRecord(grouped) && typeof grouped["downloadUrl"] === "string"
    ? grouped["downloadUrl"]
    : undefined;
};

/** Why a download was not saved: a command with no link, the fetch, or the write. */
export type SaveDownloadFailure = {
  kind: "download" | "usage" | "write";
  message: string;
};

export type SaveDownloadOptions = {
  fetcher?: (url: URL) => Promise<Response>;
  path: string;
  payload: unknown;
  write?: (path: string, bytes: Uint8Array) => Promise<void>;
};

/** Fetch the result's download and write it to `path`; the byte count saved. */
export const saveDownload = async ({
  fetcher = async (url) =>
    await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) }),
  path,
  payload,
  write = writeFile,
}: SaveDownloadOptions): Promise<Result<number, SaveDownloadFailure>> => {
  const url = readDownloadUrl(payload);
  if (url === undefined) {
    return Result.err({
      kind: "usage",
      message:
        "--save needs a command whose result has a downloadUrl; this one returned none",
    });
  }
  const parsed = Result.try(() => new URL(url));
  if (
    Result.isError(parsed) ||
    (parsed.value.protocol !== "https:" && parsed.value.protocol !== "http:")
  ) {
    return Result.err({
      kind: "download",
      message: "The result's downloadUrl is not an http(s) URL",
    });
  }
  const response = await Result.tryPromise(
    async () => await fetcher(parsed.value),
  );
  if (Result.isError(response)) {
    return Result.err({
      kind: "download",
      message: `The download failed: ${response.error.message}`,
    });
  }
  if (!response.value.ok) {
    return Result.err({
      kind: "download",
      message: `The download failed with HTTP ${String(response.value.status)}; run the command again for a fresh link`,
    });
  }
  const bytes = new Uint8Array(await response.value.arrayBuffer());
  const written = await Result.tryPromise(async () => {
    await write(path, bytes);
  });
  if (Result.isError(written)) {
    return Result.err({
      kind: "write",
      message: `Could not write ${path}: ${written.error.message}`,
    });
  }
  return Result.ok(bytes.byteLength);
};
