import { panic, TaggedError } from "better-result";
import { sql } from "drizzle-orm";

import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import {
  ONLINE_WORK_NAMES,
  type OnlineWorkName,
} from "@/api/db/online-migrations";
import { ONLINE_WORK_LIFECYCLE } from "@/api/db/online-work-lifecycle";
import { createSafeId } from "@/api/lib/branded-types";
import {
  lockOnlineWorkState,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import {
  type MaintenanceDb,
  openMaintenanceDb,
} from "@/api/lib/db/maintenance-db";
import { ONLINE_WORK_STATE_TRANSITIONS } from "@/api/lib/db/transition-specs";
import {
  transitionScopedBatch,
  transitionUpsertBatch,
} from "@/api/lib/db/transitions";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

export class OnlineWorkPauseError extends TaggedError("OnlineWorkPauseError")<{
  message: string;
}> {}

export type OnlineWorkPauseCommand =
  | { action: "status"; name?: OnlineWorkName }
  | {
      action: "pause";
      name: OnlineWorkName;
      actor: string;
      reason: string;
      apply: boolean;
      durationMinutes: number;
    }
  | {
      action: "resume";
      name: OnlineWorkName;
      actor: string;
      reason: string;
      apply: boolean;
    };

const invalid = (message: string): never => {
  throw new OnlineWorkPauseError({ message });
};

export const parseOnlineWorkPauseArgs = (
  args: readonly string[],
): OnlineWorkPauseCommand => {
  const [action, ...rest] = args;
  if (action !== "status" && action !== "pause" && action !== "resume") {
    return invalid("Expected status, pause, or resume");
  }
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (
      flag === undefined ||
      !["--step", "--for", "--actor", "--reason", "--apply"].includes(flag) ||
      flags.has(flag)
    ) {
      return invalid("Unknown or repeated flag");
    }
    if (flag === "--apply") {
      flags.set(flag, true);
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return invalid(`${flag} requires a value`);
    }
    flags.set(flag, value.trim());
    index += 1;
  }
  const rawName = flags.get("--step");
  const name = ONLINE_WORK_NAMES.find((candidate) => candidate === rawName);
  if (rawName !== undefined && name === undefined) {
    return invalid("Unknown online work step");
  }
  if (action === "status") {
    if ([...flags.keys()].some((flag) => flag !== "--step")) {
      return invalid("status accepts only --step");
    }
    return name === undefined ? { action } : { action, name };
  }
  if (name === undefined) {
    return invalid("--step is required");
  }
  const actor = flags.get("--actor");
  const reason = flags.get("--reason");
  if (
    typeof actor !== "string" ||
    actor.length === 0 ||
    typeof reason !== "string" ||
    reason.length < 8
  ) {
    return invalid(
      "--actor must not be blank and --reason needs eight characters",
    );
  }
  const apply = flags.has("--apply");
  if (action === "resume") {
    if (flags.has("--for")) {
      return invalid("resume does not accept --for");
    }
    return { action, name, actor, reason, apply };
  }
  const duration = flags.get("--for");
  const match =
    typeof duration === "string" ? /^(\d+)([mh])$/u.exec(duration) : null;
  if (match === null) {
    return invalid("--for needs a duration such as 30m or 24h");
  }
  const durationMinutes = Number(match[1]) * (match[2] === "h" ? 60 : 1);
  if (
    !Number.isSafeInteger(durationMinutes) ||
    durationMinutes <= 0 ||
    durationMinutes > 72 * 60
  ) {
    return invalid("Pauses must be positive and no longer than 72 hours");
  }
  return { action, name, actor, reason, apply, durationMinutes };
};

type RunOnlineWorkPauseOptions = {
  db: MaintenanceDb;
  now?: () => Date;
  write?: (value: string) => void;
};

export const runOnlineWorkPause = async (
  command: OnlineWorkPauseCommand,
  {
    db,
    now = () => new Date(),
    write = console.log,
  }: RunOnlineWorkPauseOptions,
) => {
  if (command.action === "status" || !command.apply) {
    const rows = await db.execute(
      sql`SELECT name, state, paused_by, paused_since, paused_until, pause_reason FROM online_work_state ${command.name === undefined ? sql`` : sql`WHERE name = ${command.name}`} ORDER BY name`,
    );
    write(
      JSON.stringify({
        action: command.action,
        apply: false,
        rows,
        ...(command.action === "pause"
          ? {
              resultingDeadline: new Date(
                now().getTime() + command.durationMinutes * 60_000,
              ).toISOString(),
            }
          : {}),
      }),
    );
    return rows;
  }
  const subject = createSafeId<"systemScriptRun">();
  return await withAggregateTransaction(db, async (tx) => {
    const audit = async (auditTx: typeof tx, rows: readonly unknown[]) => {
      await recordSystemAudit(auditTx, "system:online-work", {
        subject,
        counts: { transitions: rows.length },
      });
    };
    await transitionUpsertBatch({
      tx,
      spec: ONLINE_WORK_STATE_TRANSITIONS,
      values: [
        {
          name: command.name,
          state:
            ONLINE_WORK_LIFECYCLE[command.name].state === "finalized"
              ? "done"
              : "pending",
        },
      ],
      onExisting: "preserve",
      recordTransitionAuditEvent: audit,
    });
    const current =
      (await lockOnlineWorkState({ tx, name: command.name })) ??
      panic("Registered online work row is missing");
    if (current.state === "done") {
      return invalid("Completed online work cannot be paused or resumed");
    }
    const metadata = {
      pausedBy: command.actor,
      pauseReason: command.reason,
      updatedAt: sql`now()`,
    };
    const changed =
      command.action === "pause"
        ? await transitionScopedBatch({
            tx,
            spec: ONLINE_WORK_STATE_TRANSITIONS,
            identities: [{ name: command.name }],
            options: {
              from: ["pending", "running", "failed", "paused"],
              to: "paused",
              set: {
                ...metadata,
                pausedUntil: sql`now() + ${command.durationMinutes} * interval '1 minute'`,
              },
            },
            recordTransitionAuditEvent: audit,
          })
        : await transitionScopedBatch({
            tx,
            spec: ONLINE_WORK_STATE_TRANSITIONS,
            identities: [{ name: command.name }],
            options: {
              from: ["paused"],
              to: "pending",
              set: { ...metadata, pausedUntil: null },
            },
            recordTransitionAuditEvent: audit,
          });
    write(JSON.stringify({ action: command.action, apply: true, changed }));
    return changed;
  });
};

if (import.meta.main) {
  await runScriptWithErrorOutput(async () => {
    const command = parseOnlineWorkPauseArgs(Bun.argv.slice(2));
    await runOnlineWorkPause(command, {
      db: openMaintenanceDb({
        readOnly: command.action === "status" || !command.apply,
      }),
    });
  });
}
