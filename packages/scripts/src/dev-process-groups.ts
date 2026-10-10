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

class DevProcessInspectionError extends TaggedError(
  "DevProcessInspectionError",
)<{
  message: string;
  cause?: unknown;
}> {}
class DevProcessOwnershipError extends TaggedError("DevProcessOwnershipError")<{
  message: string;
}> {}
export class DevProcessRegistrationError extends TaggedError(
  "DevProcessRegistrationError",
)<{
  message: string;
  cause?: unknown;
}> {}
class DevProcessSignalError extends TaggedError("DevProcessSignalError")<{
  message: string;
  pgid: number;
  signal: NodeJS.Signals;
  cause: unknown;
}> {}
export class DevProcessSurvivedError extends TaggedError(
  "DevProcessSurvivedError",
)<{
  message: string;
  pgids: number[];
}> {}
export type DevProcessGroupError =
  | DevProcessInspectionError
  | DevProcessOwnershipError
  | DevProcessRegistrationError
  | DevProcessSignalError
  | DevProcessSurvivedError;

export const readDevProcessGroups = (rootDir: string) =>
  Result.try({
    try: () => {
      const file = devStatePath(rootDir, GROUPS_FILE);
      return existsSync(file)
        ? v.parse(sessionSchema, JSON.parse(readFileSync(file, "utf-8")))
        : null;
    },
    catch: (cause) =>
      new DevProcessInspectionError({
        message: "Cannot read dev process-group ownership",
        cause,
      }),
  });

type WriteSessionOptions = {
  rootDir: string;
  session: v.InferOutput<typeof sessionSchema>;
  publication: "create" | "update";
};
const writeSession = ({ rootDir, session, publication }: WriteSessionOptions) =>
  Result.try({
    try: () => {
      mkdirSync(path.join(rootDir, DEV_STATE_DIR), { recursive: true });
      const file = devStatePath(rootDir, GROUPS_FILE);
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(session)}\n`);
      if (publication === "update") {
        renameSync(temporary, file);
        return;
      }
      // Exclusive publication: two starting runners cannot overwrite ownership.
      try {
        linkSync(temporary, file);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
    catch: (cause) =>
      new DevProcessRegistrationError({
        message: "Cannot record dev process-group ownership",
        cause,
      }),
  });

// One snapshot covers every group. Zombies have exited and cannot own ports;
// reaping an orphan is the responsibility of its new parent (init).
const readProcesses = () =>
  Result.gen(function* () {
    const result = yield* Result.try({
      try: () =>
        Bun.spawnSync(["ps", "-axo", "pid=,pgid=,stat=,lstart="], {
          env: { ...process.env, LC_ALL: "C" },
          stdout: "pipe",
          stderr: "pipe",
        }),
      catch: (cause) =>
        new DevProcessInspectionError({
          message: "Cannot inspect dev process groups",
          cause,
        }),
    });
    if (!result.success) {
      return Result.err(
        new DevProcessInspectionError({
          message: "Cannot inspect dev process groups",
          cause: result.stderr.toString(),
        }),
      );
    }
    return Result.ok(
      result.stdout
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
        }),
    );
  });

export const devProcessStartedAt = (pid: number) =>
  readProcesses().map(
    (processes) =>
      processes.find(
        (entry) => entry.pid === pid && !entry.status.startsWith("Z"),
      )?.startedAt ?? null,
  );

const liveGroups = (groups: readonly ProcessGroup[]) =>
  Result.gen(function* () {
    const processes = yield* readProcesses();
    const currentGroup = processes.find(({ pid }) => pid === process.pid)?.pgid;
    const live: ProcessGroup[] = [];
    for (const group of groups) {
      if (group.pgid === currentGroup) {
        return Result.err(
          new DevProcessOwnershipError({
            message: "Refusing to signal the current process group",
          }),
        );
      }
      const leader = processes.find(({ pid }) => pid === group.pgid);
      if (
        leader &&
        (leader.pgid !== group.pgid ||
          leader.startedAt !== group.leaderStartedAt)
      ) {
        return Result.err(
          new DevProcessOwnershipError({
            message: `Refusing reused process group ${group.pgid}; recorded leader identity changed`,
          }),
        );
      }
      if (
        processes.some(
          ({ pgid, status }) => pgid === group.pgid && !status.startsWith("Z"),
        )
      ) {
        live.push(group);
      }
    }
    return Result.ok(live);
  });

const signalGroup = (pgid: number, signal: NodeJS.Signals) => {
  const sent = Result.try({
    try: () => {
      process.kill(-pgid, signal);
    },
    catch: (cause) =>
      new DevProcessSignalError({
        message: `Cannot signal dev process group ${pgid}`,
        pgid,
        signal,
        cause,
      }),
  });
  if (
    sent.isErr() &&
    sent.error.cause instanceof Error &&
    "code" in sent.error.cause &&
    sent.error.cause.code === "ESRCH"
  ) {
    return Result.ok(undefined);
  }
  return sent;
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
}: SpawnDevProcessOptions) =>
  Result.gen(function* () {
    const previous = yield* readDevProcessGroups(rootDir);
    if (
      previous &&
      (previous.runnerPid !== process.pid ||
        previous.sessionId !== ownSessionId())
    ) {
      return Result.err(
        new DevProcessOwnershipError({
          message:
            "Another dev session has recorded process groups; run agent:down first",
        }),
      );
    }
    if (previous?.status === "stopping") {
      return Result.err(
        new DevProcessOwnershipError({
          message: "Dev session is stopping; cannot start another service",
        }),
      );
    }
    const child = yield* Result.try({
      try: () =>
        Bun.spawn(cmd, {
          cwd,
          env,
          stdin,
          stdout: "inherit",
          stderr: "inherit",
          detached: true,
        }),
      catch: (cause) =>
        new DevProcessRegistrationError({
          message: `Cannot start ${label}`,
          cause,
        }),
    });
    // Record before readiness so interrupted startup remains recoverable. On a
    // write failure, terminate the newly owned group rather than orphaning it.
    const registered = Result.gen(function* () {
      const processes = yield* readProcesses();
      const leader = processes.find(({ pid }) => pid === child.pid);
      if (!leader && !processes.some(({ pgid }) => pgid === child.pid)) {
        // A short-lived background command can finish before this snapshot.
        return Result.ok(undefined);
      }
      if (leader && leader.pgid !== child.pid) {
        return Result.err(
          new DevProcessRegistrationError({
            message: `${label} did not start a process group`,
          }),
        );
      }
      const groups = previous?.groups ?? [];
      groups.push({
        pgid: child.pid,
        // Any later leader at this PID is reuse if the original already exited.
        leaderStartedAt:
          leader?.startedAt ?? "leader exited before registration",
        label,
      });
      const runnerStartedAt = yield* devProcessStartedAt(process.pid);
      return writeSession({
        rootDir,
        session: {
          runnerPid: process.pid,
          runnerStartedAt:
            runnerStartedAt ?? panic("Missing runner birth identity"),
          sessionId: ownSessionId(),
          status: "running",
          groups,
        },
        publication: previous === null ? "create" : "update",
      });
    });
    if (registered.isErr()) {
      const killed = signalGroup(child.pid, "SIGKILL");
      if (killed.isErr()) {
        return Result.err(
          new DevProcessRegistrationError({
            message: `Cannot register or terminate ${label}`,
            cause: {
              registration: registered.error,
              termination: killed.error,
            },
          }),
        );
      }
      return registered;
    }
    return Result.ok(child);
  });

type StopDevProcessGroupsOptions = {
  rootDir: string;
  graceMs?: number;
  forceMs?: number;
  runnerPid?: number;
  sessionId?: string | null;
  signal?: typeof signalGroup;
};
export const stopDevProcessGroups = async ({
  rootDir,
  graceMs = GRACE_MS,
  forceMs = FORCE_MS,
  runnerPid = process.pid,
  sessionId = ownSessionId(),
  signal = signalGroup,
}: StopDevProcessGroupsOptions): Promise<
  Result<string[], DevProcessGroupError>
> => {
  // Keep the stop transition synchronous with same-runner service registration.
  const prepared = Result.gen(function* () {
    const session = yield* readDevProcessGroups(rootDir);
    if (
      !session ||
      session.runnerPid !== runnerPid ||
      session.sessionId !== sessionId
    ) {
      return Result.ok(null);
    }
    // External recovery first stops the runner so it cannot publish a late service.
    if (
      runnerPid !== process.pid &&
      (yield* devProcessStartedAt(runnerPid)) === session.runnerStartedAt
    ) {
      return Result.err(
        new DevProcessOwnershipError({
          message:
            "Stop the owning runner before recovering its service groups",
        }),
      );
    }
    yield* writeSession({
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
    const pending = yield* liveGroups(session.groups);
    for (const { pgid } of pending) {
      yield* signal(pgid, "SIGTERM");
    }
    return Result.ok({ session, pending });
  });
  if (prepared.isErr()) {
    return prepared;
  }
  if (prepared.value === null) {
    return Result.ok([]);
  }
  const { session } = prepared.value;
  let pending = prepared.value.pending;
  const waitUntil = async (timeoutMs: number) => {
    const deadline = performance.now() + timeoutMs;
    while (pending.length > 0 && performance.now() < deadline) {
      await Bun.sleep(POLL_MS);
      const inspected = liveGroups(pending);
      if (inspected.isErr()) {
        return inspected;
      }
      pending = inspected.value;
    }
    return Result.ok(undefined);
  };
  return Result.gen(async function* () {
    yield* Result.await(waitUntil(graceMs));
    const forced = pending.map(({ label }) => label);
    for (const { pgid } of pending) {
      yield* signal(pgid, "SIGKILL");
    }
    yield* Result.await(waitUntil(forceMs));
    if (pending.length > 0) {
      const pgids = pending.map(({ pgid }) => pgid);
      return Result.err(
        new DevProcessSurvivedError({
          message: `Dev process groups survived SIGKILL: ${pgids.join(", ")}`,
          pgids,
        }),
      );
    }
    if (
      (yield* readDevProcessGroups(rootDir))?.sessionId === session.sessionId
    ) {
      yield* Result.try({
        try: () => rmSync(devStatePath(rootDir, GROUPS_FILE), { force: true }),
        catch: (cause) =>
          new DevProcessRegistrationError({
            message: "Cannot remove dev process-group ownership",
            cause,
          }),
      });
    }
    return Result.ok(forced);
  });
};
