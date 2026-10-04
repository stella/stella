import { panic, Result, TaggedError } from "better-result";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  linkSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { DEV_STATE_DIR, devStatePath } from "./dev-runtime";

const GROUPS_FILE = "process-groups.json";
export const DEV_SESSION_ID_ENV = "STELLA_DEV_SESSION_ID";
let currentSessionId: string | undefined;
const ownSessionId = () =>
  (currentSessionId ??= process.env[DEV_SESSION_ID_ENV] ?? randomUUID());
const POLL_MS = 250;
const GRACE_MS = 12_000;
const FORCE_MS = 2000;
const positivePid = v.pipe(v.number(), v.integer(), v.minValue(2));
const groupSchema = v.object({
  pgid: positivePid,
  leaderStartedAt: v.string(),
  label: v.string(),
});
const sessionSchema = v.object({
  runnerPid: positivePid,
  runnerStartedAt: v.string(),
  sessionId: v.pipe(v.string(), v.minLength(1)),
  status: v.picklist(["running", "stopping"]),
  groups: v.array(groupSchema),
});
type ProcessGroup = v.InferOutput<typeof groupSchema>;

class DevProcessGroupError extends TaggedError("DevProcessGroupError")<{
  message: string;
  cause?: unknown;
}> {}

export const readDevProcessGroups = (rootDir: string) => {
  const file = devStatePath(rootDir, GROUPS_FILE);
  return existsSync(file)
    ? v.parse(sessionSchema, JSON.parse(readFileSync(file, "utf-8")))
    : null;
};

type WriteSessionOptions = {
  rootDir: string;
  session: v.InferOutput<typeof sessionSchema>;
  publication: "create" | "update";
};
const writeSession = ({
  rootDir,
  session,
  publication,
}: WriteSessionOptions) => {
  mkdirSync(path.join(rootDir, DEV_STATE_DIR), { recursive: true });
  const file = devStatePath(rootDir, GROUPS_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(session)}\n`);
  if (publication === "update") {
    renameSync(temporary, file);
    return;
  }
  // Exclusive publication: two starting runners cannot overwrite ownership.
  const published = Result.try(() => linkSync(temporary, file));
  rmSync(temporary, { force: true });
  published.unwrap();
};

// One snapshot covers every group. Zombies have exited and cannot own ports;
// reaping an orphan is the responsibility of its new parent (init).
const readProcesses = () => {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,pgid=,stat=,lstart="], {
    env: { ...process.env, LC_ALL: "C" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success) {
    throw new DevProcessGroupError({
      message: "Cannot inspect dev process groups",
      cause: result.stderr.toString(),
    });
  }
  return result.stdout
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [pid, pgid, status, ...startedAt] = line
        .trim()
        .split(" ")
        .filter(Boolean);
      return {
        pid: Number(pid),
        pgid: Number(pgid),
        status: status ?? panic("Missing process status"),
        startedAt: startedAt.join(" "),
      };
    });
};

export const devProcessStartedAt = (pid: number) =>
  readProcesses().find(
    (entry) => entry.pid === pid && !entry.status.startsWith("Z"),
  )?.startedAt ?? null;

const liveGroups = (groups: readonly ProcessGroup[]) => {
  const processes = readProcesses();
  const currentGroup = processes.find(({ pid }) => pid === process.pid)?.pgid;
  return groups.filter((group) => {
    if (group.pgid === currentGroup) {
      throw new DevProcessGroupError({
        message: "Refusing to signal the current process group",
      });
    }
    const leader = processes.find(({ pid }) => pid === group.pgid);
    if (
      leader &&
      (leader.pgid !== group.pgid || leader.startedAt !== group.leaderStartedAt)
    ) {
      throw new DevProcessGroupError({
        message: `Refusing reused process group ${group.pgid}; recorded leader identity changed`,
      });
    }
    return processes.some(
      ({ pgid, status }) => pgid === group.pgid && !status.startsWith("Z"),
    );
  });
};

const signalGroup = (pgid: number, signal: NodeJS.Signals) => {
  const sent = Result.try(() => process.kill(-pgid, signal));
  if (sent.isOk()) {
    return;
  }
  const cause = sent.error;
  if ("code" in cause && cause.code === "ESRCH") {
    return;
  }
  throw new DevProcessGroupError({
    message: `Cannot signal dev process group ${pgid}`,
    cause,
  });
};

type SpawnDevProcessOptions = {
  rootDir: string;
  cmd: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  label: string;
  stdin: "inherit" | "ignore";
};

export const spawnDevProcess = ({
  rootDir,
  cmd,
  cwd,
  env,
  label,
  stdin,
}: SpawnDevProcessOptions) => {
  const previous = readDevProcessGroups(rootDir);
  if (
    previous &&
    (previous.runnerPid !== process.pid ||
      previous.sessionId !== ownSessionId())
  ) {
    throw new DevProcessGroupError({
      message:
        "Another dev session has recorded process groups; run agent:down first",
    });
  }
  if (previous?.status === "stopping") {
    throw new DevProcessGroupError({
      message: "Dev session is stopping; cannot start another service",
    });
  }
  const child = Bun.spawn(cmd, {
    cwd,
    env,
    stdin,
    stdout: "inherit",
    stderr: "inherit",
    detached: true,
  });
  // Record before readiness so interrupted startup remains recoverable. On a
  // write failure, terminate the newly owned group rather than orphaning it.
  const registered = Result.try(() => {
    const processes = readProcesses();
    const leader = processes.find(({ pid }) => pid === child.pid);
    if (!leader && !processes.some(({ pgid }) => pgid === child.pid)) {
      // A short-lived background command can finish before this snapshot.
      return;
    }
    if (leader && leader.pgid !== child.pid) {
      throw new DevProcessGroupError({
        message: `${label} did not start a process group`,
      });
    }
    const groups = previous?.groups ?? [];
    groups.push({
      pgid: child.pid,
      // Any later leader at this PID is reuse if the original already exited.
      leaderStartedAt: leader?.startedAt ?? "leader exited before registration",
      label,
    });
    writeSession({
      rootDir,
      session: {
        runnerPid: process.pid,
        runnerStartedAt:
          devProcessStartedAt(process.pid) ??
          panic("Missing runner birth identity"),
        sessionId: ownSessionId(),
        status: "running",
        groups,
      },
      publication: previous === null ? "create" : "update",
    });
  });
  if (registered.isErr()) {
    signalGroup(child.pid, "SIGKILL");
    throw registered.error;
  }
  return child;
};

type StopDevProcessGroupsOptions = {
  rootDir: string;
  graceMs?: number;
  forceMs?: number;
  runnerPid?: number;
  sessionId?: string | null;
};

export const stopDevProcessGroups = async ({
  rootDir,
  graceMs = GRACE_MS,
  forceMs = FORCE_MS,
  runnerPid = process.pid,
  sessionId = ownSessionId(),
}: StopDevProcessGroupsOptions) => {
  const session = readDevProcessGroups(rootDir);
  // A runner that failed before registering a group owns nothing. An old
  // cleanup must not touch a replacement session started in the same checkout.
  if (
    !session ||
    session.runnerPid !== runnerPid ||
    session.sessionId !== sessionId
  ) {
    return [];
  }
  // The owning runner serializes registration and stopping synchronously.
  // External recovery must first stop it, so it cannot publish a late service.
  if (
    runnerPid !== process.pid &&
    devProcessStartedAt(runnerPid) === session.runnerStartedAt
  ) {
    throw new DevProcessGroupError({
      message: "Stop the owning runner before recovering its service groups",
    });
  }
  writeSession({
    rootDir,
    session: {
      runnerPid,
      runnerStartedAt: session.runnerStartedAt,
      sessionId,
      status: "stopping",
      groups: session.groups,
    },
    publication: "update",
  });
  let pending = liveGroups(session.groups);
  for (const { pgid } of pending) {
    signalGroup(pgid, "SIGTERM");
  }
  const waitUntil = async (timeoutMs: number) => {
    const deadline = performance.now() + timeoutMs;
    while (pending.length > 0 && performance.now() < deadline) {
      await Bun.sleep(POLL_MS);
      pending = liveGroups(pending);
    }
  };
  await waitUntil(graceMs);
  const forced = pending.map(({ label }) => label);
  for (const { pgid } of pending) {
    signalGroup(pgid, "SIGKILL");
  }
  await waitUntil(forceMs);
  if (pending.length > 0) {
    throw new DevProcessGroupError({
      message: `Dev process groups survived SIGKILL: ${pending.map(({ pgid }) => pgid).join(", ")}`,
    });
  }
  if (readDevProcessGroups(rootDir)?.sessionId === session.sessionId) {
    rmSync(devStatePath(rootDir, GROUPS_FILE), { force: true });
  }
  return forced;
};
