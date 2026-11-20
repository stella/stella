import { Result } from "better-result";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Temporal } from "temporal-polyfill/full";
import * as v from "valibot";

import {
  DESKTOP_RUNNER_APPROVAL_MODES,
  DESKTOP_RUNNER_HARNESS_CAPABILITIES,
  DESKTOP_RUNNER_REASONING_EFFORTS,
} from "@stll/api-contract/desktop-runner";

import type { HarnessProbe } from "../adapter";

/**
 * What the ACP adapter keeps in an agent's stella-owned state directory
 * besides the agent's own files: each process's temporary directory and the
 * last probe's answer.
 */

const TEMP_FOLDER = "stella-tmp";
/** A temporary directory left this long is no process's any more. */
const TEMP_LEFTOVER_MS = Temporal.Duration.from({ hours: 24 }).total(
  "milliseconds",
);

/** The variables that point a process at its temporary directory. */
export const tempEnvironment = (
  dir: string,
  platform: NodeJS.Platform,
): Record<string, string> =>
  platform === "win32" ? { TEMP: dir, TMP: dir } : { TMPDIR: dir };

/** A new temporary directory for one process. */
export const makeProcessTempDir = (configDir: string): string => {
  const root = path.join(configDir, TEMP_FOLDER);
  mkdirSync(root, { recursive: true });
  return mkdtempSync(path.join(root, "run-"));
};

/**
 * Remove a process's temporary directory once it exited. A file the system
 * still holds (Windows) leaves it for `sweepTempDirs`.
 */
export const removeTempDir = (dir: string): boolean =>
  Result.isOk(
    Result.try(() => {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }),
  );

const OWNER_FILE = "stella-owner.json";
const OwnerSchema = v.object({
  pid: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});

/** Name the process a temporary directory belongs to, for `sweepTempDirs`. */
export const recordTempDirOwner = (dir: string, pid: number): boolean =>
  Result.isOk(
    Result.try(() => {
      writeFileSync(path.join(dir, OWNER_FILE), JSON.stringify({ pid }));
    }),
  );

/** Whether the process a temporary directory names still runs. */
const ownerRuns = (dir: string): boolean => {
  const text = Result.try(() =>
    readFileSync(path.join(dir, OWNER_FILE), "utf-8"),
  );
  const json = Result.isOk(text)
    ? Result.try((): unknown => JSON.parse(text.value))
    : null;
  const owner =
    json !== null && Result.isOk(json)
      ? v.safeParse(OwnerSchema, json.value)
      : null;
  if (owner?.success !== true) {
    return false;
  }
  const { pid } = owner.output;
  // Signal 0 only asks whether the process exists.
  return Result.isOk(Result.try(() => process.kill(pid, 0)));
};

/**
 * Remove temporary directories a process left behind (a crash, a kill):
 * old ones whose process no longer runs.
 */
export const sweepTempDirs = (configDir: string, nowMs: number) => {
  const root = path.join(configDir, TEMP_FOLDER);
  const entries = Result.try(() => readdirSync(root));
  if (Result.isError(entries)) {
    return;
  }
  for (const entry of entries.value) {
    const dir = path.join(root, entry);
    const stat = Result.try(() => statSync(dir));
    if (
      Result.isOk(stat) &&
      nowMs - stat.value.mtimeMs > TEMP_LEFTOVER_MS &&
      !ownerRuns(dir)
    ) {
      removeTempDir(dir);
    }
  }
};

const PROBE_FILE = "stella-probe.json";

const ProbeSchema = v.object({
  version: v.string(),
  auth: v.variant("type", [
    v.object({
      type: v.literal("signed_in"),
      method: v.string(),
      plan: v.nullable(v.string()),
    }),
    v.object({ type: v.literal("signed_out") }),
  ]),
  models: v.array(
    v.object({
      id: v.string(),
      displayName: v.string(),
      isDefault: v.boolean(),
      reasoningEfforts: v.array(v.picklist(DESKTOP_RUNNER_REASONING_EFFORTS)),
      inputModalities: v.array(v.string()),
    }),
  ),
  capabilities: v.array(v.picklist(DESKTOP_RUNNER_HARNESS_CAPABILITIES)),
  approvalModes: v.array(v.picklist(DESKTOP_RUNNER_APPROVAL_MODES)),
  usageLimit: v.nullable(v.object({ resetsAt: v.string() })),
});

const CachedProbeSchema = v.object({
  key: v.string(),
  at: v.number(),
  probe: ProbeSchema,
});

/**
 * What a cached probe stands for: the executable as it is on disk and
 * whether the agent's sign-in is stored. A new install or a sign-in or
 * sign-out makes the cache stale.
 */
export const probeKey = (executable: string, signedIn: boolean | null) => {
  const stat = Result.try(() => statSync(executable));
  return Result.isError(stat)
    ? null
    : `${String(stat.value.mtimeMs)}:${String(stat.value.size)}:${String(signedIn)}`;
};

export const readCachedProbe = ({
  configDir,
  key,
  maxAgeMs,
  nowMs,
}: {
  configDir: string;
  key: string;
  maxAgeMs: number;
  nowMs: number;
}): HarnessProbe | null => {
  const text = Result.try(() =>
    readFileSync(path.join(configDir, PROBE_FILE), "utf-8"),
  );
  if (Result.isError(text)) {
    return null;
  }
  const json = Result.try((): unknown => JSON.parse(text.value));
  const parsed = Result.isOk(json)
    ? v.safeParse(CachedProbeSchema, json.value)
    : null;
  if (parsed === null || !parsed.success) {
    return null;
  }
  const cached = parsed.output;
  return cached.key === key &&
    nowMs >= cached.at &&
    nowMs - cached.at < maxAgeMs
    ? cached.probe
    : null;
};

export const writeCachedProbe = ({
  configDir,
  key,
  nowMs,
  probe,
}: {
  configDir: string;
  key: string;
  nowMs: number;
  probe: HarnessProbe;
}): boolean =>
  // A cache that cannot be written only means the next probe asks again.
  Result.isOk(
    Result.try(() => {
      writeFileSync(
        path.join(configDir, PROBE_FILE),
        JSON.stringify({ key, at: nowMs, probe }),
      );
    }),
  );

const BROKEN_FILE = "stella-broken-sessions.json";
/** The newest sessions kept as broken; an older one is long out of use. */
const BROKEN_KEPT = 100;

const readBroken = (configDir: string): string[] => {
  const text = Result.try(() =>
    readFileSync(path.join(configDir, BROKEN_FILE), "utf-8"),
  );
  const json = Result.isOk(text)
    ? Result.try((): unknown => JSON.parse(text.value))
    : null;
  const parsed =
    json !== null && Result.isOk(json)
      ? v.safeParse(v.array(v.string()), json.value)
      : null;
  return parsed?.success === true ? parsed.output : [];
};

/**
 * A session whose saved state the agent can no longer continue. `false`
 * when it could not be recorded: the next turn then tries to resume it.
 */
export const markSessionBroken = (
  configDir: string,
  sessionId: string,
): boolean => {
  const kept = [
    ...readBroken(configDir).filter((id) => id !== sessionId),
    sessionId,
  ];
  return Result.isOk(
    Result.try(() => {
      writeFileSync(
        path.join(configDir, BROKEN_FILE),
        JSON.stringify(kept.slice(-BROKEN_KEPT)),
      );
    }),
  );
};

export const isSessionBroken = (configDir: string, sessionId: string) =>
  readBroken(configDir).includes(sessionId);
