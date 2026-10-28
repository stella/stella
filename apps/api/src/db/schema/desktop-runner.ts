import { AGENT_HARNESSES } from "@stll/api-contract/agent-harness";

import { denyStellaAccessPolicies } from "@/api/db/rls";
import {
  DESKTOP_RUNNER_COMMAND_KINDS,
  DESKTOP_RUNNER_CONNECTIONS,
  DESKTOP_RUNNER_EVENT_TYPES,
  DESKTOP_RUNNER_LEASED_RUN_STATES,
  DESKTOP_RUNNER_RUN_STATES,
  DESKTOP_RUNNER_STORED_OUTCOMES,
  DESKTOP_RUNNER_STORED_REJECT_REASONS,
} from "@/api/lib/desktop-runner/states";

import {
  jsonb,
  organization,
  p,
  safeOrganizationId,
  sql,
  timestamptz,
  user,
} from "./common";

// The gateway serves sockets and sweeps leases across every organization, so
// these tables are reached only through the table owner; tenant roles see none.
const ownerAccess = (table: string) =>
  sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = ${sql.raw(`'public.${table}'::regclass`)})`;

const ownerOnlyPolicies = (table: string) => [
  p.pgPolicy(`${table}_owner_access`, {
    for: "all",
    to: "public",
    using: ownerAccess(table),
    withCheck: ownerAccess(table),
  }),
  ...denyStellaAccessPolicies(),
];

const sqlValues = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql.raw(","),
  );

/**
 * One row per desktop installation and device key that has opened a runner
 * socket: which socket and API task hold it now, and what each harness on it
 * reported, so routing sees what every computer can do. Another key naming the
 * same installation gets its own row and never replaces this one.
 */
export const desktopRunners = p.pgTable.withRLS(
  "desktop_runners",
  {
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Installation id the desktop sends when it opens the socket. */
    desktopId: p.uuid("desktop_id").notNull(),
    /** RFC 7638 thumbprint of the device key that signed the socket's proof. */
    deviceJkt: p.text("device_jkt").notNull(),
    /** The latest socket; an older socket of the same desktop closes itself. */
    sessionId: p.uuid("session_id").notNull(),
    /** API task holding `session_id`, the target of its doorbell. */
    instanceId: p.text("instance_id").notNull(),
    connection: p.text({ enum: DESKTOP_RUNNER_CONNECTIONS }).notNull(),
    protocol: p.integer().notNull(),
    appVersion: p.varchar("app_version", { length: 64 }).notNull(),
    sidecarVersion: p.varchar("sidecar_version", { length: 64 }).notNull(),
    /** Each harness's latest report, as the protocol defines it. */
    harnesses: jsonb("harnesses").notNull(),
    connectedAt: timestamptz("connected_at").notNull(),
    /** Renewed by the socket's heartbeat; routing ignores a stale runner. */
    lastSeenAt: timestamptz("last_seen_at").notNull(),
  },
  (table) => [
    p.primaryKey({
      name: "desktop_runners_pkey",
      columns: [
        table.userId,
        table.organizationId,
        table.desktopId,
        table.deviceJkt,
      ],
    }),
    p.check(
      "desktop_runners_connection_check",
      sql`${table.connection} IN (${sqlValues(DESKTOP_RUNNER_CONNECTIONS)})`,
    ),
    p.check("desktop_runners_protocol_check", sql`${table.protocol} >= 0`),
    p.check(
      "desktop_runners_harnesses_check",
      sql`jsonb_typeof(${table.harnesses}) = 'array'`,
    ),
    ...ownerOnlyPolicies("desktop_runners"),
  ],
);

/**
 * A run assigned to one desktop. Desktop, device key, harness and harness
 * version are fixed when the run is assigned; a lease that expires moves the
 * run to `waiting_for_computer`, never to another desktop.
 */
export const desktopRunnerRuns = p.pgTable.withRLS(
  "desktop_runner_runs",
  {
    runId: p.uuid("run_id").notNull(),
    userId: p.text("user_id").notNull(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    desktopId: p.uuid("desktop_id").notNull(),
    /** Device key the run is bound to; a re-linked desktop does not inherit it. */
    deviceJkt: p.text("device_jkt").notNull(),
    harness: p.text({ enum: AGENT_HARNESSES }).notNull(),
    harnessVersion: p.varchar("harness_version", { length: 64 }).notNull(),
    /** Workspaces the run's MCP token may reach, authorized when assigned. */
    workspaceIds: p.text("workspace_ids").array().notNull(),
    state: p.text({ enum: DESKTOP_RUNNER_RUN_STATES }).notNull(),
    /** Set with `finished`: how the run ended, as the desktop reported. */
    outcome: p.text({ enum: DESKTOP_RUNNER_STORED_OUTCOMES }),
    /** Set with `rejected`: why the desktop refused the run. */
    rejectReason: p.text("reject_reason", {
      enum: DESKTOP_RUNNER_STORED_REJECT_REASONS,
    }),
    /** The harness session a later run on this desktop may resume. */
    harnessSessionId: p.varchar("harness_session_id", { length: 256 }),
    /** When the desktop accepted `run.start`; absent while it never has. */
    acceptedAt: timestamptz("accepted_at"),
    /** Highest position of the run's desktop messages persisted without a gap. */
    ackSeq: p.bigint("ack_seq", { mode: "number" }).notNull().default(0),
    /** UTF-8 bytes of the run's stored messages, bounded per run. */
    messageBytes: p
      .bigint("message_bytes", { mode: "number" })
      .notNull()
      .default(0),
    leaseExpiresAt: timestamptz("lease_expires_at").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.primaryKey({ name: "desktop_runner_runs_pkey", columns: [table.runId] }),
    p
      .foreignKey({
        name: "desktop_runner_runs_runner_fk",
        columns: [
          table.userId,
          table.organizationId,
          table.desktopId,
          table.deviceJkt,
        ],
        foreignColumns: [
          desktopRunners.userId,
          desktopRunners.organizationId,
          desktopRunners.desktopId,
          desktopRunners.deviceJkt,
        ],
      })
      .onDelete("cascade"),
    p
      .index("desktop_runner_runs_runner_state_idx")
      .on(table.userId, table.organizationId, table.desktopId, table.state),
    p
      .index("desktop_runner_runs_lease_idx")
      .on(table.leaseExpiresAt)
      .where(
        sql`${table.state} IN (${sqlValues(DESKTOP_RUNNER_LEASED_RUN_STATES)})`,
      ),
    p.check(
      "desktop_runner_runs_harness_check",
      sql`${table.harness} IN (${sqlValues(AGENT_HARNESSES)})`,
    ),
    p.check(
      "desktop_runner_runs_state_check",
      sql`${table.state} IN (${sqlValues(DESKTOP_RUNNER_RUN_STATES)})`,
    ),
    p.check(
      "desktop_runner_runs_outcome_check",
      sql`(${table.state} = 'finished') = (${table.outcome} IS NOT NULL) AND (${table.outcome} IS NULL OR ${table.outcome} IN (${sqlValues(DESKTOP_RUNNER_STORED_OUTCOMES)}))`,
    ),
    p.check(
      "desktop_runner_runs_reject_reason_check",
      sql`(${table.state} = 'rejected') = (${table.rejectReason} IS NOT NULL) AND (${table.rejectReason} IS NULL OR ${table.rejectReason} IN (${sqlValues(DESKTOP_RUNNER_STORED_REJECT_REASONS)}))`,
    ),
    p.check(
      "desktop_runner_runs_ack_seq_check",
      sql`${table.ackSeq} BETWEEN 0 AND 4294967295`,
    ),
    p.check(
      "desktop_runner_runs_message_bytes_check",
      sql`${table.messageBytes} >= 0`,
    ),
    ...ownerOnlyPolicies("desktop_runner_runs"),
  ],
);

/**
 * Commands for a run, in the order they were queued. Each is idempotent on its
 * key (`runId`, `requestId` or `inputId`), kept until the run is deleted and
 * replayed whenever its desktop reconnects; the desktop drops what it has seen.
 * A stored `run.start` holds no MCP token: one is minted on every send.
 */
export const desktopRunnerCommands = p.pgTable.withRLS(
  "desktop_runner_commands",
  {
    id: p.bigint({ mode: "number" }).generatedAlwaysAsIdentity({
      name: "desktop_runner_commands_id_seq",
    }),
    runId: p
      .uuid("run_id")
      .notNull()
      .references(() => desktopRunnerRuns.runId, { onDelete: "cascade" }),
    kind: p.text({ enum: DESKTOP_RUNNER_COMMAND_KINDS }).notNull(),
    /** The id the command is idempotent on. */
    commandKey: p.uuid("command_key").notNull(),
    /** The server message as sent, without a token. */
    payload: jsonb("payload").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.primaryKey({ name: "desktop_runner_commands_pkey", columns: [table.id] }),
    p
      .uniqueIndex("desktop_runner_commands_key_idx")
      .on(table.runId, table.kind, table.commandKey),
    p.check(
      "desktop_runner_commands_kind_check",
      sql`${table.kind} IN (${sqlValues(DESKTOP_RUNNER_COMMAND_KINDS)})`,
    ),
    p.check(
      "desktop_runner_commands_payload_check",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
    ...ownerOnlyPolicies("desktop_runner_commands"),
  ],
);

/**
 * The desktop messages of a run that take a position in its sequence (events,
 * approval requests, the final message), each stored once and acknowledged
 * only after it is here.
 */
export const desktopRunnerEvents = p.pgTable.withRLS(
  "desktop_runner_events",
  {
    runId: p
      .uuid("run_id")
      .notNull()
      .references(() => desktopRunnerRuns.runId, { onDelete: "cascade" }),
    seq: p.bigint({ mode: "number" }).notNull(),
    type: p.text({ enum: DESKTOP_RUNNER_EVENT_TYPES }).notNull(),
    /** Set on an approval request, so an answer can be matched to it. */
    requestId: p.uuid("request_id"),
    /** The desktop message as validated. */
    message: jsonb("message").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.primaryKey({
      name: "desktop_runner_events_pkey",
      columns: [table.runId, table.seq],
    }),
    p
      .uniqueIndex("desktop_runner_events_request_idx")
      .on(table.runId, table.requestId)
      .where(sql`${table.requestId} IS NOT NULL`),
    p.check(
      "desktop_runner_events_type_check",
      sql`${table.type} IN (${sqlValues(DESKTOP_RUNNER_EVENT_TYPES)})`,
    ),
    p.check(
      "desktop_runner_events_seq_check",
      sql`${table.seq} BETWEEN 1 AND 4294967295`,
    ),
    p.check(
      "desktop_runner_events_request_check",
      sql`(${table.type} = 'run.approval_request') = (${table.requestId} IS NOT NULL)`,
    ),
    p.check(
      "desktop_runner_events_message_check",
      sql`jsonb_typeof(${table.message}) = 'object'`,
    ),
    ...ownerOnlyPolicies("desktop_runner_events"),
  ],
);
