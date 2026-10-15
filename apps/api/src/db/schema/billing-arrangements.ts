import {
  centsColumn,
  organization,
  p,
  safeOrganizationId,
  safeWorkspaceId,
  sql,
  timestamptz,
  wsOrganizationPolicies,
} from "./common";
import { workspaces } from "./contacts";

export const BILLING_ARRANGEMENT_MODES = ["hourly", "flat_fee"] as const;

const BILLING_CAP_BOUNDARY_STATES = ["below", "above"] as const;
const BILLING_CURRENCY_STATES = ["matched", "mismatch"] as const;
const BILLING_CAP_BOUNDARY_STATE_SQL_VALUES = BILLING_CAP_BOUNDARY_STATES.map(
  (state) => sql.raw(`'${state}'`),
);
const BILLING_CURRENCY_STATE_SQL_VALUES = BILLING_CURRENCY_STATES.map((state) =>
  sql.raw(`'${state}'`),
);

export const billingArrangements = p.pgTable(
  "billing_arrangements",
  {
    workspaceId: safeWorkspaceId("workspace_id").primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    mode: p.text("mode", { enum: BILLING_ARRANGEMENT_MODES }).notNull(),
    currency: p.varchar("currency", { length: 3 }).notNull(),
    // PostgreSQL bigint; centsColumn preserves the bounded CentsAmount JSON number boundary.
    flatFeeAmount: centsColumn("flat_fee_amount"),
    capAmount: centsColumn("cap_amount"),
    alertThresholdBps: p.integer("alert_threshold_bps"),
    thresholdState: p
      .text("threshold_state", { enum: BILLING_CAP_BOUNDARY_STATES })
      .notNull()
      .default("below"),
    capState: p
      .text("cap_state", { enum: BILLING_CAP_BOUNDARY_STATES })
      .notNull()
      .default("below"),
    currencyState: p
      .text("currency_state", { enum: BILLING_CURRENCY_STATES })
      .notNull()
      .default("matched"),
    crossingSequence: p.integer("crossing_sequence").notNull().default(0),
    revision: p.integer("revision").notNull().default(1),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "billing_arrangements_workspace_organization_fk",
      })
      .onDelete("cascade"),
    p.check(
      "billing_arrangements_mode_check",
      sql`(
      (${table.mode} = 'flat_fee' AND ${table.flatFeeAmount} IS NOT NULL AND ${table.flatFeeAmount} >= 0 AND ${table.capAmount} IS NULL AND ${table.alertThresholdBps} IS NULL)
      OR (${table.mode} = 'hourly' AND ${table.flatFeeAmount} IS NULL AND (
        (${table.capAmount} IS NULL AND ${table.alertThresholdBps} IS NULL)
        OR (${table.capAmount} IS NOT NULL AND ${table.alertThresholdBps} IS NOT NULL AND ${table.capAmount} > 0 AND ${table.alertThresholdBps} BETWEEN 1 AND 10000)
      ))
    )`,
    ),
    p.check(
      "billing_arrangements_currency_check",
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    p.check(
      "billing_arrangements_amount_bounds_check",
      sql`(${table.flatFeeAmount} IS NULL OR ${table.flatFeeAmount} <= 9007199254740991) AND (${table.capAmount} IS NULL OR ${table.capAmount} <= 9007199254740991)`,
    ),
    p.check(
      "billing_arrangements_crossing_check",
      sql`${table.currencyState} IN (${sql.join(BILLING_CURRENCY_STATE_SQL_VALUES, sql`, `)}) AND ${table.thresholdState} IN (${sql.join(BILLING_CAP_BOUNDARY_STATE_SQL_VALUES, sql`, `)}) AND ${table.capState} IN (${sql.join(BILLING_CAP_BOUNDARY_STATE_SQL_VALUES, sql`, `)}) AND ${table.crossingSequence} >= 0 AND ${table.revision} > 0`,
    ),
    ...wsOrganizationPolicies("billing_arrangements", { columns: table }),
  ],
);
