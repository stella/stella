// Which screenshots may leave the machine. `agent:drive` records every
// capture with its hash and whether the stack held only seeded content before
// and after it; `agent:attach` uploads a file only when that record says so
// and the file is byte-for-byte the one captured. Everything else (a desktop
// capture, a download, an edited image) has no record and is refused.

import { panic } from "better-result";
import path from "node:path";

export type SealStatus =
  | { status: "fresh" }
  | { status: "pristine" }
  | { status: "modified"; tables: readonly string[] }
  | { status: "unsealed" };

// A seal may be (re)written only over a database that is fresh or still
// matches its previous seal; anything else would absorb earlier content into
// the baseline.
export const isSealTrusted = (seal: SealStatus | null) =>
  seal?.status === "fresh" || seal?.status === "pristine";

export type CaptureRecord = {
  label: string;
  path: string;
  sha256: string;
  // Text was typed, pasted or dropped into the page before this capture.
  // Unsaved input never reaches the database, so the seal cannot see it.
  textEntered: boolean;
  url: string;
};

export type ManifestEntry = CaptureRecord & {
  attachable: boolean;
  capturedAt: string;
  // Why an entry is not attachable; null when it is.
  reason: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export const parseSealStatus = (output: string): SealStatus | null => {
  const line = output.trim().split("\n").at(-1) ?? "";
  const parsed: unknown = line.startsWith("{") ? JSON.parse(line) : null;
  if (!isRecord(parsed)) {
    return null;
  }
  switch (parsed["status"]) {
    case "fresh":
    case "pristine":
    case "unsealed": {
      return { status: parsed["status"] };
    }
    case "modified": {
      return isStringArray(parsed["tables"])
        ? { status: "modified", tables: parsed["tables"] }
        : null;
    }
    default: {
      return null;
    }
  }
};

const isCaptureRecord = (value: unknown): value is CaptureRecord =>
  isRecord(value) &&
  typeof value["label"] === "string" &&
  typeof value["path"] === "string" &&
  typeof value["sha256"] === "string" &&
  typeof value["textEntered"] === "boolean" &&
  typeof value["url"] === "string";

export const parseCaptureLog = (text: string): CaptureRecord[] =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (!isCaptureRecord(parsed)) {
        return panic(`Malformed capture record: ${line}`);
      }
      return parsed;
    });

const describeSeal = (seal: SealStatus) => {
  switch (seal.status) {
    case "pristine": {
      return null;
    }
    case "fresh": {
      return "the stack has not been seeded";
    }
    case "unsealed": {
      return "the stack has no seal (it held non-seeded content when it started); run `bun run agent:reset`";
    }
    case "modified": {
      return `the stack holds content created after the seed (${seal.tables.join(", ")}); run \`bun run agent:reset\` and capture again`;
    }
    default: {
      seal satisfies never;
      return panic(`Unhandled seal: ${JSON.stringify(seal)}`);
    }
  }
};

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

type DecideAttachableOptions = {
  after: SealStatus;
  before: SealStatus;
  record: CaptureRecord;
};

// Checked on both sides of a capture: a `run` script can create content
// between the two.
export const decideAttachable = ({
  after,
  before,
  record,
}: DecideAttachableOptions): Pick<ManifestEntry, "attachable" | "reason"> => {
  if (!LOCAL_HOSTNAMES.has(new URL(record.url).hostname)) {
    return { attachable: false, reason: `captured at ${record.url}` };
  }
  if (record.textEntered) {
    return {
      attachable: false,
      reason:
        "text was entered on the page before it; capture states reachable by clicking only",
    };
  }
  const reason = describeSeal(before) ?? describeSeal(after);
  return reason === null
    ? { attachable: true, reason: null }
    : { attachable: false, reason };
};

const isManifestEntry = (value: unknown): value is ManifestEntry =>
  isRecord(value) &&
  typeof value["attachable"] === "boolean" &&
  typeof value["capturedAt"] === "string" &&
  (value["reason"] === null || typeof value["reason"] === "string") &&
  isCaptureRecord(value);

export const parseManifest = (text: string): ManifestEntry[] => {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every(isManifestEntry)) {
    return panic("The evidence manifest has an unexpected shape");
  }
  return parsed;
};

type VerifyAttachmentOptions = {
  evidenceDir: string;
  // Real path of the file offered for upload.
  filePath: string;
  fileSha256: string;
  manifest: readonly ManifestEntry[];
};

export type AttachmentVerdict =
  | { type: "ok"; entry: ManifestEntry }
  | { type: "refused"; reason: string };

export const verifyAttachment = ({
  evidenceDir,
  filePath,
  fileSha256,
  manifest,
}: VerifyAttachmentOptions): AttachmentVerdict => {
  const relative = path.relative(evidenceDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return {
      type: "refused",
      reason: `${filePath} is not an agent:drive capture`,
    };
  }
  const entry = manifest.findLast((candidate) => candidate.path === filePath);
  if (entry === undefined) {
    return {
      type: "refused",
      reason: `${filePath} has no capture record`,
    };
  }
  if (entry.sha256 !== fileSha256) {
    return {
      type: "refused",
      reason: `${filePath} changed after it was captured`,
    };
  }
  if (!entry.attachable) {
    return {
      type: "refused",
      reason: `${filePath} is not attachable: ${entry.reason ?? "unknown"}`,
    };
  }
  return { type: "ok", entry };
};

// `gh pr edit --attach` arrived in 2.101.0.
const MINIMUM_GH_VERSION = [2, 101, 0] as const;

export const ghSupportsAttach = (versionOutput: string) => {
  const match = /gh version (?<version>\d+\.\d+\.\d+)/u.exec(versionOutput);
  const parts = (match?.groups?.["version"] ?? "0.0.0").split(".").map(Number);
  for (const [index, minimum] of MINIMUM_GH_VERSION.entries()) {
    const part = parts[index] ?? 0;
    if (part !== minimum) {
      return part > minimum;
    }
  }
  return true;
};
