/**
 * The managed agent CLIs' installs as the native side reports them
 * (`harness_commands::HarnessStatus`, `harness_installation::HarnessInstallState`).
 */

export const HARNESS_INSTALL_CHANGED_EVENT = "harness-install-changed";

const MANAGED_HARNESSES = ["codex", "claude-code"] as const;
export type ManagedHarness = (typeof MANAGED_HARNESSES)[number];

const HARNESS_INSTALL_FAILURES = [
  "download_failed",
  "oversize",
  "incomplete",
  "digest_mismatch",
  "archive_rejected",
  "probe_failed",
  "storage",
  "corrupt_install",
] as const;
export type HarnessInstallFailure = (typeof HARNESS_INSTALL_FAILURES)[number];

export type HarnessInstallState =
  | { state: "not_installed" }
  | {
      state: "downloading";
      operationId: string;
      version: string;
      downloadedBytes: number;
      totalBytes: number;
      active: string | null;
    }
  | {
      state: "verifying";
      operationId: string;
      version: string;
      active: string | null;
    }
  | { state: "ready"; active: string }
  | { state: "failed"; reason: HarnessInstallFailure; active: string | null };

export type HarnessStatus = {
  harness: ManagedHarness;
  state: HarnessInstallState;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOptionalString = (value: unknown) =>
  value === null || typeof value === "string";

const isByteCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isHarness = (value: unknown): value is ManagedHarness =>
  MANAGED_HARNESSES.some((harness) => harness === value);

const isFailure = (value: unknown): value is HarnessInstallFailure =>
  HARNESS_INSTALL_FAILURES.some((failure) => failure === value);

const isHarnessInstallState = (
  value: unknown,
): value is HarnessInstallState => {
  if (!isRecord(value)) {
    return false;
  }
  switch (value["state"]) {
    case "not_installed": {
      return true;
    }
    case "downloading": {
      return (
        typeof value["operationId"] === "string" &&
        typeof value["version"] === "string" &&
        isByteCount(value["downloadedBytes"]) &&
        isByteCount(value["totalBytes"]) &&
        isOptionalString(value["active"])
      );
    }
    case "verifying": {
      return (
        typeof value["operationId"] === "string" &&
        typeof value["version"] === "string" &&
        isOptionalString(value["active"])
      );
    }
    case "ready": {
      return typeof value["active"] === "string";
    }
    case "failed": {
      return isFailure(value["reason"]) && isOptionalString(value["active"]);
    }
    default: {
      return false;
    }
  }
};

/**
 * The list `harness_get_status` returns. A list holding anything malformed
 * is refused as a whole.
 */
export const isHarnessStatusList = (
  value: unknown,
): value is readonly HarnessStatus[] =>
  Array.isArray(value) &&
  value.every(
    (entry) =>
      isRecord(entry) &&
      isHarness(entry["harness"]) &&
      isHarnessInstallState(entry["state"]),
  );

export const harnessInstallState = (
  list: readonly HarnessStatus[] | null,
  harness: ManagedHarness,
): HarnessInstallState | null =>
  list?.find((status) => status.harness === harness)?.state ?? null;

const PERCENT = 100;

/** Whole percent downloaded, never above 100. */
export const downloadPercent = ({
  downloadedBytes,
  totalBytes,
}: {
  downloadedBytes: number;
  totalBytes: number;
}) =>
  totalBytes > 0
    ? Math.min(PERCENT, Math.floor((downloadedBytes / totalBytes) * PERCENT))
    : 0;
