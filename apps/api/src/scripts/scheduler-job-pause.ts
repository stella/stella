/**
 * Inspect, pause, or resume a declared scheduler job.
 *
 *   bun run scheduler:job-pause -- status [--job <id>]
 *   bun run scheduler:job-pause -- pause --job <id> --for 24h --reason <text> --actor <operator> [--apply]
 *   bun run scheduler:job-pause -- resume --job <id> --reason <text> --actor <operator> [--apply]
 */
import { TaggedError } from "better-result";
import { sql } from "drizzle-orm";

import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import type { MaintenanceDb } from "@/api/lib/db/maintenance-db";
import { openMaintenanceDb } from "@/api/lib/db/maintenance-db";
import { DECLARED_SCHEDULER_JOBS } from "@/api/lib/scheduler/jobs";

const MAX_PAUSE_MINUTES = 72 * 60;
const MIN_REASON_LENGTH = 8;

export class SchedulerJobPauseError extends TaggedError(
  "SchedulerJobPauseError",
)<{
  code: "invalid-arguments" | "job-not-found";
  message: string;
}> {}

export type SchedulerJobPauseCommand =
  | { action: "status"; jobId?: string }
  | {
      action: "pause";
      actor: string;
      apply: boolean;
      durationMinutes: number;
      jobId: string;
      reason: string;
    }
  | {
      action: "resume";
      actor: string;
      apply: boolean;
      jobId: string;
      reason: string;
    };

export type SchedulerJobPauseRow = {
  enabled: boolean;
  id: string;
  pauseReason: string | null;
  pausedBy: string | null;
  pausedSince: Date | null;
  pausedUntil: Date | null;
};

const validJobIds = DECLARED_SCHEDULER_JOBS.map(({ id }) => id).toSorted();
const usage =
  "Usage: scheduler:job-pause -- status [--job <id>] | pause --job <id> --for <minutes|hours> --reason <text> --actor <operator> [--apply] | resume --job <id> --reason <text> --actor <operator> [--apply]";

const invalid = (message: string): never => {
  throw new SchedulerJobPauseError({
    code: "invalid-arguments",
    message: `${message}\n${usage}`,
  });
};

const validateJobId = (jobId: string | undefined): string => {
  if (jobId === undefined) {
    return invalid("--job is required");
  }
  if (!validJobIds.some((validJobId) => validJobId === jobId)) {
    throw new SchedulerJobPauseError({
      code: "invalid-arguments",
      message: `Unknown scheduler job id ${JSON.stringify(jobId)}. Valid ids: ${validJobIds.join(", ")}`,
    });
  }
  return jobId;
};

const parseDurationMinutes = (value: string | undefined): number => {
  if (value === undefined) {
    return invalid("--for is required");
  }
  const match = /^(\d+)([mh])$/u.exec(value);
  if (match === null) {
    return invalid(
      "--for must be a positive duration in minutes or hours, such as 30m or 24h",
    );
  }
  const amount = Number(match[1]);
  const durationMinutes = match[2] === "h" ? amount * 60 : amount;
  if (!Number.isSafeInteger(durationMinutes) || durationMinutes <= 0) {
    return invalid("--for must be greater than zero");
  }
  if (durationMinutes > MAX_PAUSE_MINUTES) {
    return invalid("--for must not exceed 72 hours");
  }
  return durationMinutes;
};

type ParsedFlags = ReadonlyMap<string, string | true>;

const parseFlags = (args: readonly string[]): ParsedFlags => {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--apply") {
      if (flags.has(flag)) {
        return invalid(`${flag} may only be supplied once`);
      }
      flags.set(flag, true);
      continue;
    }
    if (!["--job", "--for", "--reason", "--actor"].includes(flag ?? "")) {
      return invalid(`Unknown argument ${JSON.stringify(flag)}`);
    }
    if (flag === undefined) {
      return invalid("A flag is required");
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return invalid(`${flag} requires a value`);
    }
    if (flags.has(flag)) {
      return invalid(`${flag} may only be supplied once`);
    }
    flags.set(flag, value);
    index += 1;
  }
  return flags;
};

const stringFlag = (flags: ParsedFlags, name: string): string | undefined => {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
};

const requiredAttribution = (
  flags: ParsedFlags,
): { actor: string; reason: string } => {
  const rawActor = stringFlag(flags, "--actor");
  if (rawActor === undefined || rawActor.trim().length === 0) {
    return invalid("--actor must not be blank");
  }
  const rawReason = stringFlag(flags, "--reason");
  if (rawReason === undefined || rawReason.trim().length < MIN_REASON_LENGTH) {
    return invalid(
      "--reason must contain at least eight characters after trimming",
    );
  }
  return { actor: rawActor.trim(), reason: rawReason.trim() };
};

export const parseSchedulerJobPauseArgs = (
  args: readonly string[],
): SchedulerJobPauseCommand => {
  const [action, ...rest] = args;
  if (action !== "pause" && action !== "resume" && action !== "status") {
    return invalid("An action of pause, resume, or status is required");
  }
  const flags = parseFlags(rest);
  const job = stringFlag(flags, "--job");
  if (action === "status") {
    if (
      flags.has("--apply") ||
      flags.has("--for") ||
      flags.has("--reason") ||
      flags.has("--actor")
    ) {
      return invalid("status accepts only --job");
    }
    return job === undefined
      ? { action }
      : { action, jobId: validateJobId(job) };
  }
  const jobId = validateJobId(job);
  const { actor, reason } = requiredAttribution(flags);
  const apply = flags.has("--apply");
  if (action === "pause") {
    return {
      action,
      actor,
      apply,
      durationMinutes: parseDurationMinutes(stringFlag(flags, "--for")),
      jobId,
      reason,
    };
  }
  if (flags.has("--for")) {
    return invalid("resume does not accept --for");
  }
  return { action, actor, apply, jobId, reason };
};

const rowSelection = sql`
  id,
  enabled,
  paused_by AS "pausedBy",
  paused_since AS "pausedSince",
  paused_until AS "pausedUntil",
  pause_reason AS "pauseReason"`;

const formatValue = (value: boolean | Date | string | null): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return JSON.stringify(value);
};

export const formatSchedulerJobPauseRow = (
  label: "CURRENT" | "RESULT" | "STATUS",
  row: SchedulerJobPauseRow,
): string =>
  `${label} id=${formatValue(row.id)} enabled=${formatValue(row.enabled)} paused_by=${formatValue(row.pausedBy)} paused_since=${formatValue(row.pausedSince)} paused_until=${formatValue(row.pausedUntil)} pause_reason=${formatValue(row.pauseReason)}`;

const findRows = async (
  db: Pick<MaintenanceDb, "execute">,
  jobId?: string,
): Promise<SchedulerJobPauseRow[]> =>
  await db.execute<SchedulerJobPauseRow>(
    jobId === undefined
      ? sql`SELECT ${rowSelection} FROM scheduler_jobs ORDER BY id`
      : sql`SELECT ${rowSelection} FROM scheduler_jobs WHERE id = ${jobId}`,
  );

// Mirrors the scheduler_job_pause_bound trigger: renewing a live pause keeps
// its start, any other pause starts now, and a resume clears it.
const resultingPausedSince = (
  current: SchedulerJobPauseRow,
  pausedUntil: Date | null,
  at: Date,
): Date | null => {
  if (pausedUntil === null) {
    return null;
  }
  if (current.pausedUntil !== null && current.pausedUntil > at) {
    return current.pausedSince;
  }
  return at;
};

type RunSchedulerJobPauseOptions = {
  db: Pick<MaintenanceDb, "execute">;
  now?: () => Date;
  write?: (line: string) => void;
};

export const runSchedulerJobPause = async (
  command: SchedulerJobPauseCommand,
  {
    db,
    now = () => new Date(),
    write = console.log,
  }: RunSchedulerJobPauseOptions,
): Promise<readonly SchedulerJobPauseRow[]> => {
  if (command.action === "status") {
    const rows = await findRows(db, command.jobId);
    for (const row of rows) {
      write(formatSchedulerJobPauseRow("STATUS", row));
    }
    return rows;
  }

  if (!command.apply) {
    const rows = await findRows(db, command.jobId);
    const current = rows.at(0);
    if (current === undefined) {
      throw new SchedulerJobPauseError({
        code: "job-not-found",
        message: `Scheduler job ${command.jobId} has no database row`,
      });
    }
    write(formatSchedulerJobPauseRow("CURRENT", current));
    const at = now();
    const pausedUntil =
      command.action === "pause"
        ? new Date(at.getTime() + command.durationMinutes * 60_000)
        : null;
    write(
      formatSchedulerJobPauseRow("RESULT", {
        ...current,
        pauseReason: command.reason,
        pausedBy: command.actor,
        pausedSince: resultingPausedSince(current, pausedUntil, at),
        pausedUntil,
      }),
    );
    write("DRY_RUN apply=false");
    return rows;
  }

  const rows = await db.execute<SchedulerJobPauseRow>(
    command.action === "pause"
      ? sql`UPDATE scheduler_jobs
          SET paused_by = ${command.actor},
              pause_reason = ${command.reason},
              paused_until = now() + ${command.durationMinutes} * interval '1 minute',
              updated_at = now()
          WHERE id = ${command.jobId}
          RETURNING ${rowSelection}`
      : sql`UPDATE scheduler_jobs
          SET paused_by = ${command.actor},
              pause_reason = ${command.reason},
              paused_until = NULL,
              updated_at = now()
          WHERE id = ${command.jobId}
          RETURNING ${rowSelection}`,
  );
  const changed = rows.at(0);
  if (changed === undefined) {
    throw new SchedulerJobPauseError({
      code: "job-not-found",
      message: `Scheduler job ${command.jobId} has no database row; no update was applied`,
    });
  }
  write(formatSchedulerJobPauseRow("RESULT", changed));
  return rows;
};

if (import.meta.main) {
  await runScriptWithErrorOutput(async () => {
    const command = parseSchedulerJobPauseArgs(Bun.argv.slice(2));
    const db = openMaintenanceDb({
      readOnly: command.action === "status" || !command.apply,
    });
    await runSchedulerJobPause(command, { db });
  });
}
