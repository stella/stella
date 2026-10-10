import { sql } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import { AGENT_AUTH_ID_JAG_CLOCK_SKEW_SECONDS } from "@/api/agent-auth/id-jag-policy";
import type { SchedulerDb, SchedulerTask } from "@/api/lib/scheduler/types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

export const SWEEP_REGISTRATIONS_TASK = "auth.sweepRegistrations" as const;
export const REGISTRATION_RETENTION_BATCH_SIZE = 100;

// sql-perf-allow: index verification_expires_at_idx restricts malformed-value inspection to unexpired verification rows
const unusedClient = (now: Date) => sql`
  NOT EXISTS (SELECT 1 FROM oauth_consent WHERE client_id = c.client_id)
  AND NOT EXISTS (
    SELECT 1 FROM oauth_access_token WHERE client_id = c.client_id
    AND expires_at > ${now.toISOString()}::timestamptz
  )
  AND NOT EXISTS (SELECT 1 FROM oauth_refresh_token WHERE client_id = c.client_id)
  AND NOT EXISTS (
    SELECT 1 FROM verification v
    WHERE v.expires_at >= ${now.toISOString()}::timestamptz
    AND CASE WHEN pg_input_is_valid(v.value, 'jsonb') THEN
      COALESCE(v.value::jsonb #>> '{query,client_id}',
        v.value::jsonb ->> 'clientId', v.value::jsonb ->> 'client_id') = c.client_id
      OR (v.value::jsonb ->> 'type' = 'authorization_code' AND
        COALESCE(v.value::jsonb #>> '{query,client_id}',
          v.value::jsonb ->> 'clientId', v.value::jsonb ->> 'client_id') IS NULL)
      ELSE v.value LIKE '%authorization_code%' END
  )
`;

export const registrationRetentionRegistrationCandidates = (now: Date) => sql`
  SELECT id, client_id FROM agent_registration
  WHERE expires_at < ${now.toISOString()}::timestamptz
  AND status IN ('pending', 'expired')
  AND bound_user_id IS NULL AND authorization_code IS NULL
  ORDER BY expires_at, id LIMIT ${REGISTRATION_RETENTION_BATCH_SIZE}
  FOR UPDATE SKIP LOCKED
`;

type RegistrationRetentionClientCandidatesOptions = {
  now: Date;
  retentionDays: number;
  registrationClientIds?: string[];
};

export const registrationRetentionClientCandidates = ({
  now,
  retentionDays,
  registrationClientIds = [],
}: RegistrationRetentionClientCandidatesOptions) => {
  const cutoff = new Date(
    now.getTime() - retentionDays * DAY_IN_MS,
  ).toISOString();
  const registrationIds = sql`ARRAY[${sql.join(
    registrationClientIds.map((id) => sql`${id}`),
    sql`, `,
  )}]::text[]`;
  return sql`
    SELECT c.client_id FROM oauth_client c WHERE c.client_id IN (
      SELECT unnest(${registrationIds})
      UNION ALL
      (SELECT c.client_id FROM oauth_client c
      WHERE c.registration_origin IN ('historical', 'open-client', 'agent')
      AND c.created_at < ${cutoff}::timestamptz AND c.updated_at < ${cutoff}::timestamptz
      AND NOT EXISTS (SELECT 1 FROM agent_registration r WHERE r.client_id = c.client_id)
      AND ${unusedClient(now)}
      ORDER BY c.updated_at, c.client_id LIMIT ${REGISTRATION_RETENTION_BATCH_SIZE - registrationClientIds.length})
    )
    ORDER BY c.client_id LIMIT ${REGISTRATION_RETENTION_BATCH_SIZE}
    FOR UPDATE OF c SKIP LOCKED
  `;
};

type SweepRegistrationsOptions = {
  db: SchedulerDb;
  now: Date;
  retentionDays: number;
};

export const sweepRegistrations = async ({
  db,
  now,
  retentionDays,
}: SweepRegistrationsOptions) =>
  await db.transaction(async (tx) => {
    // Ceremony locks hold claim transitions; client locks serialize usage writes.
    const selectedRegistrations = await tx.execute<{
      id: string;
      client_id: string;
    }>(registrationRetentionRegistrationCandidates(now));
    const clients = await tx.execute<{ client_id: string }>(
      registrationRetentionClientCandidates({
        now,
        retentionDays,
        registrationClientIds: selectedRegistrations.map(
          ({ client_id }) => client_id,
        ),
      }),
    );
    const clientIds = clients.map(({ client_id }) => client_id);
    const clientIdArray = sql`ARRAY[${sql.join(
      clientIds.map((id) => sql`${id}`),
      sql`, `,
    )}]::text[]`;
    const registrationIdArray = sql`ARRAY[${sql.join(
      selectedRegistrations.map(({ id }) => sql`${id}`),
      sql`, `,
    )}]::text[]`;
    const verifications = await tx.execute(sql`
      DELETE FROM verification WHERE id IN (
        SELECT id FROM verification WHERE expires_at < ${now.toISOString()}::timestamptz
        ORDER BY expires_at, id LIMIT ${REGISTRATION_RETENTION_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      ) RETURNING id
    `);
    const assertions = await tx.execute(sql`
      DELETE FROM oauth_client_assertion WHERE id IN (
        SELECT id FROM oauth_client_assertion WHERE expires_at < ${now.toISOString()}::timestamptz
        ORDER BY expires_at, id LIMIT ${REGISTRATION_RETENTION_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      ) RETURNING id
    `);
    const replayCutoff = new Date(
      now.getTime() - AGENT_AUTH_ID_JAG_CLOCK_SKEW_SECONDS * 1000,
    ).toISOString();
    const replays = await tx.execute(sql`
      DELETE FROM agent_assertion_replay WHERE jti IN (
        SELECT jti FROM agent_assertion_replay WHERE expires_at < ${replayCutoff}::timestamptz
        ORDER BY expires_at, jti LIMIT ${REGISTRATION_RETENTION_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      ) RETURNING jti
    `);
    const registrations = await tx.execute<{ client_id: string }>(sql`
      DELETE FROM agent_registration r WHERE r.id = ANY(${registrationIdArray})
      AND r.expires_at < ${now.toISOString()}::timestamptz
      AND r.status IN ('pending', 'expired')
      AND r.bound_user_id IS NULL AND r.authorization_code IS NULL
      RETURNING r.client_id
    `);
    const expiredClientIds = sql`ARRAY[${sql.join(
      registrations.map(({ client_id }) => sql`${client_id}`),
      sql`, `,
    )}]::text[]`;
    const cutoff = new Date(
      now.getTime() - retentionDays * DAY_IN_MS,
    ).toISOString();
    const deletedClients = await tx.execute(sql`
      DELETE FROM oauth_client c
      WHERE c.client_id = ANY(${clientIdArray})
      AND c.registration_origin <> 'managed'
      AND ${unusedClient(now)}
      AND (c.client_id = ANY(${expiredClientIds}) OR (
        c.registration_origin IN ('historical', 'open-client', 'agent')
        AND c.created_at < ${cutoff}::timestamptz AND c.updated_at < ${cutoff}::timestamptz
      ))
      AND NOT EXISTS (SELECT 1 FROM agent_registration r WHERE r.client_id = c.client_id)
      RETURNING c.client_id
    `);
    const budgets = await tx.execute(sql`
      DELETE FROM registration_daily_budget WHERE (day, kind) IN (
        SELECT day, kind FROM registration_daily_budget
        WHERE day < ${new Date(now.getTime() - 2 * DAY_IN_MS).toISOString()}::timestamptz
        ORDER BY day, kind LIMIT ${REGISTRATION_RETENTION_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      ) RETURNING day
    `);
    return {
      verificationsDeleted: verifications.length,
      assertionsDeleted: assertions.length,
      replaysDeleted: replays.length,
      registrationsDeleted: registrations.length,
      clientsDeleted: deletedClients.length,
      budgetsDeleted: budgets.length,
      hasMore:
        selectedRegistrations.length === REGISTRATION_RETENTION_BATCH_SIZE ||
        replays.length === REGISTRATION_RETENTION_BATCH_SIZE ||
        verifications.length === REGISTRATION_RETENTION_BATCH_SIZE ||
        assertions.length === REGISTRATION_RETENTION_BATCH_SIZE ||
        clients.length === REGISTRATION_RETENTION_BATCH_SIZE ||
        registrations.length === REGISTRATION_RETENTION_BATCH_SIZE ||
        budgets.length === REGISTRATION_RETENTION_BATCH_SIZE,
    };
  });

export const sweepRegistrationRecords: SchedulerTask = async ({
  db,
  runId,
  signal,
  scheduleContinuation,
  logger,
}) => {
  signal.throwIfAborted();
  const { env } = await import("@/api/env");
  const result = await sweepRegistrations({
    db,
    now: new Date(),
    retentionDays: env.UNUSED_CLIENT_RETENTION_DAYS,
  });
  await recordSystemAudit(db, "system:registration-retention", {
    subject: runId,
    counts: {
      verifications: result.verificationsDeleted,
      assertions: result.assertionsDeleted,
      replays: result.replaysDeleted,
      registrations: result.registrationsDeleted,
      clients: result.clientsDeleted,
      budgets: result.budgetsDeleted,
    },
  });
  logger.info("scheduler.registration_retention", result);
  if (result.hasMore && !signal.aborted) {
    scheduleContinuation(new Date());
  }
};
