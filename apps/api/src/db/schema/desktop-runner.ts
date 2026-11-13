import { AGENT_HARNESSES } from "@stll/api-contract/agent-harness";
import {
  CHAT_LOCAL_FILES_UNDO_COMPUTER_REFUSALS,
  CHAT_LOCAL_FILES_UNDO_LIVE_STATES,
  CHAT_LOCAL_FILES_UNDO_SETTLED_STATES,
  CHAT_LOCAL_FILES_UNDO_STATES,
} from "@stll/api-contract/chat-local-files-undo";

import { denyStellaAccessPolicies } from "@/api/db/rls";
import {
  DESKTOP_RUNNER_COMMAND_KINDS,
  DESKTOP_RUNNER_CONNECTIONS,
  DESKTOP_RUNNER_EVENT_TYPES,
  DESKTOP_RUNNER_LEASED_RUN_STATES,
  DESKTOP_RUNNER_LOST_REASONS,
  DESKTOP_RUNNER_RUN_STATES,
  DESKTOP_RUNNER_STORED_OUTCOMES,
  DESKTOP_RUNNER_STORED_REJECT_REASONS,
} from "@/api/lib/desktop-runner/states";

import { chatThreads, chatTurns } from "./chat";
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
    /**
     * The credential that opened the latest socket. Revoking a credential
     * disconnects only the runners it opened; another credential on the same
     * device key keeps its own.
     */
    keyId: p.text("key_id").notNull(),
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
    /**
     * The folders the member linked on the computer, by id, name and state as
     * it last reported them; their paths never leave the computer.
     */
    linkedFolders: jsonb("linked_folders").notNull().default([]),
    /**
     * Linked folders the member let runs work in. A run in a folder not
     * listed here is refused, so the first run in a newly linked folder asks.
     */
    approvedFolderIds: p
      .uuid("approved_folder_ids")
      .array()
      .notNull()
      .default([]),
    /**
     * How many tasks the harness process each run left behind keeps running
     * in the background, by run id, as the computer reported them over its
     * current socket (`run.background`), while the run's chat waits for its
     * next turn. A run with none has no entry; a socket's claim starts from
     * none, and the computer reports the live ones again after `welcome`.
     */
    backgroundTasks: jsonb("background_tasks").notNull().default({}),
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
    /**
     * The folder linked on the computer the run works in; null for the
     * chat's own. An undo of the run's files restores that folder.
     */
    linkedFolderId: p.uuid("linked_folder_id"),
    state: p.text({ enum: DESKTOP_RUNNER_RUN_STATES }).notNull(),
    /** Set with `finished`: how the run ended, as the desktop reported. */
    outcome: p.text({ enum: DESKTOP_RUNNER_STORED_OUTCOMES }),
    /** Set with `rejected`: why the desktop refused the run. */
    rejectReason: p.text("reject_reason", {
      enum: DESKTOP_RUNNER_STORED_REJECT_REASONS,
    }),
    /** Set with `lost` where the API knows why (`DESKTOP_RUNNER_LOST_REASONS`). */
    lostReason: p.text("lost_reason", { enum: DESKTOP_RUNNER_LOST_REASONS }),
    /** The harness session a later run on this desktop may resume. */
    harnessSessionId: p.varchar("harness_session_id", { length: 256 }),
    /**
     * When `run.start` was first written to one of the computer's sockets;
     * absent while it never was. A run never written ends after the short
     * unaccepted window, one that was keeps the recovery window, since its
     * computer may be running it.
     */
    deliveredAt: timestamptz("delivered_at"),
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
    /**
     * The chat thread whose turn started the run; null for runs started
     * outside chat. The run and its messages go with the thread.
     */
    chatThreadId: p.uuid("chat_thread_id"),
    /**
     * The chat turn that reads the run; null for runs started outside chat,
     * and for a chat run whose turn was deleted. The run lives as long as the
     * turn holds it: once the turn ends other than paused on an answer the
     * run can take, or is deleted, the API cancels the run.
     */
    chatTurnId: p.uuid("chat_turn_id"),
    /**
     * Last position of the run's messages a chat turn consumed. A turn that
     * paused for an approval continues reading after it.
     */
    chatReadSeq: p
      .bigint("chat_read_seq", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.primaryKey({ name: "desktop_runner_runs_pkey", columns: [table.runId] }),
    p
      .foreignKey({
        name: "desktop_runner_runs_chat_thread_fk",
        columns: [table.chatThreadId],
        foreignColumns: [chatThreads.id],
      })
      .onDelete("cascade"),
    p
      .index("desktop_runner_runs_chat_thread_idx")
      .on(table.chatThreadId, table.desktopId, table.harness)
      .where(sql`${table.chatThreadId} IS NOT NULL`),
    p
      .foreignKey({
        name: "desktop_runner_runs_chat_turn_fk",
        columns: [table.chatTurnId],
        foreignColumns: [chatTurns.id],
      })
      .onDelete("set null"),
    p
      .index("desktop_runner_runs_chat_turn_idx")
      .on(table.chatTurnId)
      .where(sql`${table.chatTurnId} IS NOT NULL`),
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
      "desktop_runner_runs_lost_reason_check",
      sql`(${table.lostReason} IS NULL OR ${table.state} = 'lost') AND (${table.lostReason} IS NULL OR ${table.lostReason} IN (${sqlValues(DESKTOP_RUNNER_LOST_REASONS)}))`,
    ),
    p.check(
      "desktop_runner_runs_ack_seq_check",
      sql`${table.ackSeq} BETWEEN 0 AND 4294967295`,
    ),
    p.check(
      "desktop_runner_runs_message_bytes_check",
      sql`${table.messageBytes} >= 0`,
    ),
    p.check(
      "desktop_runner_runs_chat_read_seq_check",
      sql`${table.chatReadSeq} BETWEEN 0 AND 4294967295`,
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
    /**
     * The server message as sent, without a token; a `run.answer` holds its
     * answers sealed (`sealedAnswers`), never as plain text.
     */
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
    /**
     * The request an answer is matched to: set on an approval request, and on
     * an event whose chunk pauses the run for a blocking question (the id of
     * the question's interrupt).
     */
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
      sql`(${table.type} <> 'run.approval_request' OR ${table.requestId} IS NOT NULL) AND (${table.type} <> 'run.finished' OR ${table.requestId} IS NULL)`,
    ),
    p.check(
      "desktop_runner_events_message_check",
      sql`jsonb_typeof(${table.message}) = 'object'`,
    ),
    ...ownerOnlyPolicies("desktop_runner_events"),
  ],
);

/**
 * The calls a run's MCP token made to a stella tool that one of chat's apps
 * presents, in the order the server answered them: what the tool returned
 * to that run, as the server sent it. Chat shows an app for a call the run
 * reported only by pairing the report with one of these rows, so what an
 * app shows is never a copy the desktop sent. Bounded per run and deleted
 * with the run.
 */
export const desktopRunnerAppCalls = p.pgTable.withRLS(
  "desktop_runner_app_calls",
  {
    /** Orders a run's answers as the server gave them. */
    id: p.bigint({ mode: "number" }).generatedAlwaysAsIdentity(),
    runId: p
      .uuid("run_id")
      .notNull()
      .references(() => desktopRunnerRuns.runId, { onDelete: "cascade" }),
    toolName: p.varchar("tool_name", { length: 128 }).notNull(),
    /** SHA-256 of the call's arguments as the server received them. */
    argumentsHash: p.varchar("arguments_hash", { length: 64 }).notNull(),
    resourceUri: p.varchar("resource_uri", { length: 256 }).notNull(),
    /** The tool's `structuredContent`, as the server answered the run. */
    result: jsonb("result").notNull(),
    /** The chat call this row was paired with; null while it is unpaired. */
    pairedToolCallId: p.varchar("paired_tool_call_id", { length: 256 }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.primaryKey({
      name: "desktop_runner_app_calls_pkey",
      columns: [table.id],
    }),
    p.index("desktop_runner_app_calls_run_idx").on(table.runId, table.id),
    p
      .uniqueIndex("desktop_runner_app_calls_paired_idx")
      .on(table.runId, table.pairedToolCallId)
      .where(sql`${table.pairedToolCallId} IS NOT NULL`),
    p.check(
      "desktop_runner_app_calls_hash_check",
      sql`${table.argumentsHash} ~ '^[0-9a-f]{64}$'`,
    ),
    p.check(
      "desktop_runner_app_calls_result_check",
      sql`jsonb_typeof(${table.result}) = 'object'`,
    ),
    ...ownerOnlyPolicies("desktop_runner_app_calls"),
  ],
);

/**
 * A member's request to undo the file changes of a chat turn run on their
 * computer: the chat's folder goes back to the checkpoint the run took before
 * it started. Not a run command: it goes to the run's computer whether or not
 * a run is open there. A queued request expires unsent after a short while,
 * so a computer that is away never restores days later; a sent one waits for
 * its answer, also past that time, and is sent again on the computer's next
 * socket. A turn has at most one restore that is queued, sent or done; a
 * refused or expired one can be asked again.
 */
export const desktopRunnerFolderRestores = p.pgTable.withRLS(
  "desktop_runner_folder_restores",
  {
    id: p.uuid("id").notNull(),
    userId: p.text("user_id").notNull(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    chatThreadId: p.uuid("chat_thread_id").notNull(),
    chatTurnId: p.uuid("chat_turn_id").notNull(),
    /** The run whose checkpoint the folder goes back to. */
    runId: p.uuid("run_id").notNull(),
    /** The run's computer and device key; only that socket is sent it. */
    desktopId: p.uuid("desktop_id").notNull(),
    deviceJkt: p.text("device_jkt").notNull(),
    state: p.text({ enum: CHAT_LOCAL_FILES_UNDO_STATES }).notNull(),
    /** Set with `refused`: why the computer refused it. */
    reason: p.text({ enum: CHAT_LOCAL_FILES_UNDO_COMPUTER_REFUSALS }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    /** A `queued` request not sent by then is never sent. */
    expiresAt: timestamptz("expires_at").notNull(),
    /** When it was restored, refused or expired. */
    settledAt: timestamptz("settled_at"),
    /**
     * The latest run whose request carried the note that the folder went
     * back; it is told once the computer accepts that run.
     */
    notedRunId: p.uuid("noted_run_id"),
    /** When an accepted run of the chat was told the folder went back. */
    notedAt: timestamptz("noted_at"),
  },
  (table) => [
    p.primaryKey({
      name: "desktop_runner_folder_restores_pkey",
      columns: [table.id],
    }),
    p
      .foreignKey({
        name: "desktop_runner_folder_restores_chat_thread_fk",
        columns: [table.chatThreadId],
        foreignColumns: [chatThreads.id],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "desktop_runner_folder_restores_chat_turn_fk",
        columns: [table.chatTurnId],
        foreignColumns: [chatTurns.id],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "desktop_runner_folder_restores_run_fk",
        columns: [table.runId],
        foreignColumns: [desktopRunnerRuns.runId],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "desktop_runner_folder_restores_runner_fk",
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
      .foreignKey({
        name: "desktop_runner_folder_restores_noted_run_fk",
        columns: [table.notedRunId],
        foreignColumns: [desktopRunnerRuns.runId],
      })
      .onDelete("set null"),
    p
      .uniqueIndex("desktop_runner_folder_restores_live_run_idx")
      .on(table.runId)
      .where(
        sql`${table.state} IN (${sqlValues(CHAT_LOCAL_FILES_UNDO_LIVE_STATES)})`,
      ),
    p
      .index("desktop_runner_folder_restores_runner_state_idx")
      .on(
        table.userId,
        table.organizationId,
        table.desktopId,
        table.deviceJkt,
        table.state,
      ),
    p
      .index("desktop_runner_folder_restores_chat_thread_idx")
      .on(table.chatThreadId, table.state),
    p
      .index("desktop_runner_folder_restores_chat_turn_idx")
      .on(table.chatTurnId, table.createdAt, table.id),
    p
      .index("desktop_runner_folder_restores_noted_run_idx")
      .on(table.notedRunId)
      .where(sql`${table.notedAt} IS NULL`),
    p.check(
      "desktop_runner_folder_restores_state_check",
      sql`${table.state} IN (${sqlValues(CHAT_LOCAL_FILES_UNDO_STATES)})`,
    ),
    p.check(
      "desktop_runner_folder_restores_reason_check",
      sql`(${table.state} = 'refused') = (${table.reason} IS NOT NULL) AND (${table.reason} IS NULL OR ${table.reason} IN (${sqlValues(CHAT_LOCAL_FILES_UNDO_COMPUTER_REFUSALS)}))`,
    ),
    p.check(
      "desktop_runner_folder_restores_settled_check",
      sql`(${table.state} IN (${sqlValues(CHAT_LOCAL_FILES_UNDO_SETTLED_STATES)})) = (${table.settledAt} IS NOT NULL)`,
    ),
    p.check(
      "desktop_runner_folder_restores_noted_check",
      sql`(${table.notedAt} IS NULL AND ${table.notedRunId} IS NULL) OR ${table.state} = 'restored'`,
    ),
    ...ownerOnlyPolicies("desktop_runner_folder_restores"),
  ],
);
