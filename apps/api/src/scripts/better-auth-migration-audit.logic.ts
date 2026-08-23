/**
 * Read-only, redacted invariants for the Better Auth 1.6 -> 1.7 migration.
 *
 * The audit deliberately keeps database rows and counts out of its report.
 * Counts live only in a private baseline file passed between rehearsal phases;
 * stdout contains stable check names and statuses only.
 */

import { Result, TaggedError } from "better-result";
import { getColumns, getTableName, sql } from "drizzle-orm";
import type { SQL, Table } from "drizzle-orm";

import { authSchema } from "@/api/db/auth-schema";
import { isRecord } from "@/api/lib/type-guards";

export const BETTER_AUTH_AUDIT_MODES = {
  POST_BACKFILL: "post-backfill",
  POST_MIGRATION: "post-migration",
  PRE_MIGRATION: "pre-migration",
} as const;

export type BetterAuthAuditMode =
  (typeof BETTER_AUTH_AUDIT_MODES)[keyof typeof BETTER_AUTH_AUDIT_MODES];

const AUTH_PROVIDER_IDS = {
  CREDENTIAL: "credential",
  GOOGLE: "google",
  MICROSOFT: "microsoft",
} as const;

const ACCOUNT_ISSUERS = {
  CREDENTIAL: "local:credential",
  GOOGLE: "https://accounts.google.com",
  MICROSOFT_PREFIX: "https://login.microsoftonline.com/",
  MICROSOFT_SUFFIX: "/v2.0",
} as const;

type AuthModel = keyof typeof authSchema;

type ForeignKeyPolicy = {
  column: string;
  referencedColumn: string;
  referencedModel: AuthModel;
};

type AuthTableAuditPolicy = {
  foreignKeys: readonly ForeignKeyPolicy[];
  preservedColumns: readonly string[];
  tableName: string;
};

type AuthAccessPolicy = {
  access: "denied" | "scoped";
  policyNames: readonly string[];
  tableName: string;
};

const columnNames = (table: Table) =>
  Object.values(getColumns(table)).map(({ name }) => name);

/**
 * Total by construction: adding a table to `authSchema` fails typechecking
 * until its preservation and reachability policy is chosen here.
 */
export const AUTH_TABLE_AUDIT_POLICY = {
  account: {
    foreignKeys: [
      { column: "user_id", referencedColumn: "id", referencedModel: "user" },
    ],
    preservedColumns: columnNames(authSchema.account),
    tableName: getTableName(authSchema.account),
  },
  apikey: {
    foreignKeys: [
      {
        column: "reference_id",
        referencedColumn: "id",
        referencedModel: "user",
      },
    ],
    preservedColumns: columnNames(authSchema.apikey),
    tableName: getTableName(authSchema.apikey),
  },
  invitation: {
    foreignKeys: [
      {
        column: "organization_id",
        referencedColumn: "id",
        referencedModel: "organization",
      },
      { column: "inviter_id", referencedColumn: "id", referencedModel: "user" },
    ],
    preservedColumns: columnNames(authSchema.invitation),
    tableName: getTableName(authSchema.invitation),
  },
  jwks: {
    foreignKeys: [],
    preservedColumns: columnNames(authSchema.jwks),
    tableName: getTableName(authSchema.jwks),
  },
  member: {
    foreignKeys: [
      {
        column: "organization_id",
        referencedColumn: "id",
        referencedModel: "organization",
      },
      { column: "user_id", referencedColumn: "id", referencedModel: "user" },
    ],
    preservedColumns: columnNames(authSchema.member),
    tableName: getTableName(authSchema.member),
  },
  oauthAccessToken: {
    foreignKeys: [
      {
        column: "client_id",
        referencedColumn: "client_id",
        referencedModel: "oauthClient",
      },
      {
        column: "session_id",
        referencedColumn: "id",
        referencedModel: "session",
      },
      { column: "user_id", referencedColumn: "id", referencedModel: "user" },
      {
        column: "refresh_id",
        referencedColumn: "id",
        referencedModel: "oauthRefreshToken",
      },
    ],
    preservedColumns: columnNames(authSchema.oauthAccessToken),
    tableName: getTableName(authSchema.oauthAccessToken),
  },
  oauthClient: {
    foreignKeys: [
      { column: "user_id", referencedColumn: "id", referencedModel: "user" },
    ],
    preservedColumns: columnNames(authSchema.oauthClient),
    tableName: getTableName(authSchema.oauthClient),
  },
  oauthConsent: {
    foreignKeys: [
      {
        column: "client_id",
        referencedColumn: "client_id",
        referencedModel: "oauthClient",
      },
      { column: "user_id", referencedColumn: "id", referencedModel: "user" },
    ],
    preservedColumns: columnNames(authSchema.oauthConsent),
    tableName: getTableName(authSchema.oauthConsent),
  },
  oauthRefreshToken: {
    foreignKeys: [
      {
        column: "client_id",
        referencedColumn: "client_id",
        referencedModel: "oauthClient",
      },
      {
        column: "session_id",
        referencedColumn: "id",
        referencedModel: "session",
      },
      { column: "user_id", referencedColumn: "id", referencedModel: "user" },
    ],
    preservedColumns: columnNames(authSchema.oauthRefreshToken),
    tableName: getTableName(authSchema.oauthRefreshToken),
  },
  organization: {
    foreignKeys: [],
    preservedColumns: columnNames(authSchema.organization),
    tableName: getTableName(authSchema.organization),
  },
  session: {
    foreignKeys: [
      { column: "user_id", referencedColumn: "id", referencedModel: "user" },
    ],
    preservedColumns: columnNames(authSchema.session),
    tableName: getTableName(authSchema.session),
  },
  twoFactor: {
    foreignKeys: [
      { column: "user_id", referencedColumn: "id", referencedModel: "user" },
    ],
    preservedColumns: columnNames(authSchema.twoFactor),
    tableName: getTableName(authSchema.twoFactor),
  },
  user: {
    foreignKeys: [],
    preservedColumns: columnNames(authSchema.user),
    tableName: getTableName(authSchema.user),
  },
  verification: {
    foreignKeys: [],
    preservedColumns: columnNames(authSchema.verification),
    tableName: getTableName(authSchema.verification),
  },
} as const satisfies Record<AuthModel, AuthTableAuditPolicy>;

/**
 * Separate from table coverage on purpose. A 1.7-only table is audited but is
 * not expected in the baseline written by the 1.6 image. When `authSchema`
 * grows, this total map forces that preservation decision at compile time.
 */
const AUTH_BASELINE_DISPOSITION = {
  account: "preserve",
  apikey: "preserve",
  invitation: "preserve",
  jwks: "preserve",
  member: "preserve",
  oauthAccessToken: "preserve",
  oauthClient: "preserve",
  oauthConsent: "preserve",
  oauthRefreshToken: "preserve",
  organization: "preserve",
  session: "preserve",
  twoFactor: "preserve",
  user: "preserve",
  verification: "preserve",
} as const satisfies Record<AuthModel, "introduced" | "preserve">;

const isPreservedDisposition = (value: "introduced" | "preserve") =>
  value === "preserve";

const AUTH_MODEL_NAMES = Object.entries(AUTH_BASELINE_DISPOSITION)
  .filter(([, disposition]) => isPreservedDisposition(disposition))
  .map(([model]) => model);
const AUTH_TABLE_POLICIES = Object.values(AUTH_TABLE_AUDIT_POLICY);

const isAuthModel = (value: string): value is AuthModel =>
  Object.hasOwn(AUTH_TABLE_AUDIT_POLICY, value);

const AUTH_ACCESS_POLICY = {
  account: {
    access: "denied",
    policyNames: ["auth_no_stella_access"],
    tableName: AUTH_TABLE_AUDIT_POLICY.account.tableName,
  },
  apikey: {
    access: "denied",
    policyNames: ["auth_no_stella_access"],
    tableName: AUTH_TABLE_AUDIT_POLICY.apikey.tableName,
  },
  invitation: {
    access: "denied",
    policyNames: ["auth_no_stella_access"],
    tableName: AUTH_TABLE_AUDIT_POLICY.invitation.tableName,
  },
  jwks: {
    access: "denied",
    policyNames: ["auth_no_stella_access"],
    tableName: AUTH_TABLE_AUDIT_POLICY.jwks.tableName,
  },
  member: {
    access: "scoped",
    policyNames: [
      "auth_member_select",
      "auth_member_update_last_active_workspace",
    ],
    tableName: AUTH_TABLE_AUDIT_POLICY.member.tableName,
  },
  oauthAccessToken: {
    access: "denied",
    policyNames: ["auth_no_stella_access"],
    tableName: AUTH_TABLE_AUDIT_POLICY.oauthAccessToken.tableName,
  },
  oauthClient: {
    access: "denied",
    policyNames: ["auth_no_stella_access"],
    tableName: AUTH_TABLE_AUDIT_POLICY.oauthClient.tableName,
  },
  oauthConsent: {
    access: "denied",
    policyNames: ["auth_no_stella_access"],
    tableName: AUTH_TABLE_AUDIT_POLICY.oauthConsent.tableName,
  },
  oauthRefreshToken: {
    access: "denied",
    policyNames: ["auth_no_stella_access"],
    tableName: AUTH_TABLE_AUDIT_POLICY.oauthRefreshToken.tableName,
  },
  organization: {
    access: "scoped",
    policyNames: ["auth_organization_select"],
    tableName: AUTH_TABLE_AUDIT_POLICY.organization.tableName,
  },
  session: {
    access: "denied",
    policyNames: ["auth_no_stella_access"],
    tableName: AUTH_TABLE_AUDIT_POLICY.session.tableName,
  },
  twoFactor: {
    access: "denied",
    policyNames: ["auth_no_stella_access"],
    tableName: AUTH_TABLE_AUDIT_POLICY.twoFactor.tableName,
  },
  user: {
    access: "scoped",
    policyNames: ["auth_user_select"],
    tableName: AUTH_TABLE_AUDIT_POLICY.user.tableName,
  },
  verification: {
    access: "denied",
    policyNames: ["auth_no_stella_access"],
    tableName: AUTH_TABLE_AUDIT_POLICY.verification.tableName,
  },
} as const satisfies Record<AuthModel, AuthAccessPolicy>;

const FUTURE_AUTH_TABLES = {
  OAUTH_CLIENT_ASSERTION: "oauth_client_assertion",
  OAUTH_CLIENT_RESOURCE: "oauth_client_resource",
  OAUTH_RESOURCE: "oauth_resource",
} as const;

const FUTURE_AUTH_ACCESS_POLICY = Object.values(FUTURE_AUTH_TABLES).map(
  (tableName) => ({
    access: "denied" as const,
    policyNames: ["auth_no_stella_access"],
    tableName,
  }),
);

const POST_BACKFILL_COLUMNS = {
  account: ["issuer"],
  oauth_access_token: ["resources"],
  oauth_client: ["application_type", "client_credentials_scopes"],
  oauth_consent: ["resources"],
  oauth_client_resource: ["client_id", "resource_id"],
  oauth_resource: ["identifier"],
  oauth_refresh_token: ["resources"],
} as const;

const POST_MIGRATION_COLUMNS = {
  account: ["issuer"],
  oauth_access_token: [
    "authorization_code_id",
    "confirmation",
    "requested_user_info_claims",
    "resources",
    "revoked",
  ],
  oauth_client: [
    "application_type",
    "backchannel_logout_session_required",
    "backchannel_logout_uri",
    "client_credentials_scopes",
    "client_discovery_id",
    "dpop_bound_access_tokens",
    "jwks",
    "jwks_uri",
    // Kept through the rollback window for the Better Auth 1.6 image.
    "public",
    "type",
  ],
  oauth_client_assertion: ["expires_at", "id"],
  oauth_client_resource: [
    "client_id",
    "created_at",
    "id",
    "metadata",
    "resource_id",
  ],
  oauth_consent: ["requested_user_info_claims", "resources"],
  oauth_refresh_token: [
    "authorization_code_id",
    "confirmation",
    "requested_user_info_claims",
    "resources",
    "rotated_at",
    "rotation_replay_expires_at",
    "rotation_replay_response",
  ],
  oauth_resource: [
    "access_token_ttl",
    "allowed_scopes",
    "created_at",
    "custom_claims",
    "disabled",
    "dpop_bound_access_tokens_required",
    "id",
    "identifier",
    "metadata",
    "name",
    "policy_version",
    "refresh_token_ttl",
    "signing_algorithm",
    "signing_key_id",
    "updated_at",
  ],
} as const;

export const BETTER_AUTH_AUDIT_CHECKS = {
  ACCOUNT_IDENTITY_COMPLETE: "account-identity-complete",
  ACCOUNT_IDENTITY_UNIQUE: "account-identity-unique",
  ACCOUNT_ISSUERS_TRUSTED: "account-issuers-trusted",
  ACCOUNT_PROVIDERS_CLASSIFIED: "account-providers-classified",
  AUTH_FOREIGN_KEYS_REACHABLE: "auth-foreign-keys-reachable",
  AUTH_FOREIGN_KEYS_VALIDATED: "auth-foreign-keys-validated",
  AUTH_ACCESS_BOUNDARIES: "auth-access-boundaries",
  AUTH_ROWS_BASELINED: "auth-rows-baselined",
  AUTH_ROWS_PRESERVED: "auth-rows-preserved",
  CREDENTIAL_ACCOUNT_OWNERSHIP: "credential-account-ownership",
  CURRENT_SCHEMA_COMPLETE: "current-auth-schema-complete",
  FINAL_ACCOUNT_CONSTRAINTS: "final-account-constraints",
  FINAL_SCHEMA_COMPLETE: "final-auth-schema-complete",
  OAUTH_CLIENTS_CLASSIFIED: "oauth-clients-classified",
  OAUTH_CLIENT_RESOURCE_LINKS: "oauth-client-resource-links-complete",
  OAUTH_RESOURCE_REFERENCES: "oauth-resource-references-reachable",
  POST_BACKFILL_SCHEMA_COMPLETE: "post-backfill-schema-complete",
  POST_MIGRATION_CONSTRAINTS: "post-migration-constraints",
} as const;

type BetterAuthAuditCheckName =
  (typeof BETTER_AUTH_AUDIT_CHECKS)[keyof typeof BETTER_AUTH_AUDIT_CHECKS];

const CHECKS_BY_MODE = {
  [BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION]: [
    BETTER_AUTH_AUDIT_CHECKS.CURRENT_SCHEMA_COMPLETE,
    BETTER_AUTH_AUDIT_CHECKS.AUTH_ACCESS_BOUNDARIES,
    BETTER_AUTH_AUDIT_CHECKS.AUTH_FOREIGN_KEYS_REACHABLE,
    BETTER_AUTH_AUDIT_CHECKS.AUTH_FOREIGN_KEYS_VALIDATED,
    BETTER_AUTH_AUDIT_CHECKS.ACCOUNT_PROVIDERS_CLASSIFIED,
    BETTER_AUTH_AUDIT_CHECKS.CREDENTIAL_ACCOUNT_OWNERSHIP,
    BETTER_AUTH_AUDIT_CHECKS.AUTH_ROWS_BASELINED,
  ],
  [BETTER_AUTH_AUDIT_MODES.POST_BACKFILL]: [
    BETTER_AUTH_AUDIT_CHECKS.CURRENT_SCHEMA_COMPLETE,
    BETTER_AUTH_AUDIT_CHECKS.POST_BACKFILL_SCHEMA_COMPLETE,
    BETTER_AUTH_AUDIT_CHECKS.AUTH_ACCESS_BOUNDARIES,
    BETTER_AUTH_AUDIT_CHECKS.AUTH_FOREIGN_KEYS_REACHABLE,
    BETTER_AUTH_AUDIT_CHECKS.AUTH_FOREIGN_KEYS_VALIDATED,
    BETTER_AUTH_AUDIT_CHECKS.ACCOUNT_PROVIDERS_CLASSIFIED,
    BETTER_AUTH_AUDIT_CHECKS.CREDENTIAL_ACCOUNT_OWNERSHIP,
    BETTER_AUTH_AUDIT_CHECKS.ACCOUNT_IDENTITY_COMPLETE,
    BETTER_AUTH_AUDIT_CHECKS.ACCOUNT_IDENTITY_UNIQUE,
    BETTER_AUTH_AUDIT_CHECKS.ACCOUNT_ISSUERS_TRUSTED,
    BETTER_AUTH_AUDIT_CHECKS.OAUTH_CLIENT_RESOURCE_LINKS,
    BETTER_AUTH_AUDIT_CHECKS.OAUTH_CLIENTS_CLASSIFIED,
    BETTER_AUTH_AUDIT_CHECKS.OAUTH_RESOURCE_REFERENCES,
    BETTER_AUTH_AUDIT_CHECKS.AUTH_ROWS_PRESERVED,
  ],
  [BETTER_AUTH_AUDIT_MODES.POST_MIGRATION]: [
    BETTER_AUTH_AUDIT_CHECKS.CURRENT_SCHEMA_COMPLETE,
    BETTER_AUTH_AUDIT_CHECKS.POST_BACKFILL_SCHEMA_COMPLETE,
    BETTER_AUTH_AUDIT_CHECKS.AUTH_ACCESS_BOUNDARIES,
    BETTER_AUTH_AUDIT_CHECKS.AUTH_FOREIGN_KEYS_REACHABLE,
    BETTER_AUTH_AUDIT_CHECKS.AUTH_FOREIGN_KEYS_VALIDATED,
    BETTER_AUTH_AUDIT_CHECKS.ACCOUNT_PROVIDERS_CLASSIFIED,
    BETTER_AUTH_AUDIT_CHECKS.CREDENTIAL_ACCOUNT_OWNERSHIP,
    BETTER_AUTH_AUDIT_CHECKS.ACCOUNT_IDENTITY_COMPLETE,
    BETTER_AUTH_AUDIT_CHECKS.ACCOUNT_IDENTITY_UNIQUE,
    BETTER_AUTH_AUDIT_CHECKS.ACCOUNT_ISSUERS_TRUSTED,
    BETTER_AUTH_AUDIT_CHECKS.OAUTH_CLIENT_RESOURCE_LINKS,
    BETTER_AUTH_AUDIT_CHECKS.OAUTH_CLIENTS_CLASSIFIED,
    BETTER_AUTH_AUDIT_CHECKS.OAUTH_RESOURCE_REFERENCES,
    BETTER_AUTH_AUDIT_CHECKS.FINAL_SCHEMA_COMPLETE,
    BETTER_AUTH_AUDIT_CHECKS.FINAL_ACCOUNT_CONSTRAINTS,
    BETTER_AUTH_AUDIT_CHECKS.POST_MIGRATION_CONSTRAINTS,
    BETTER_AUTH_AUDIT_CHECKS.AUTH_ROWS_PRESERVED,
  ],
} as const satisfies Record<
  BetterAuthAuditMode,
  readonly BetterAuthAuditCheckName[]
>;

export type BetterAuthAuditCheck = {
  name: BetterAuthAuditCheckName;
  status: "failed" | "passed";
};

export type BetterAuthAuditBaseline = {
  formatVersion: 1;
  tables: Record<
    string,
    { primaryKeyDigest: string; rowContentDigest: string; rowCount: string }
  >;
};

export type BetterAuthAuditReport = {
  checks: readonly BetterAuthAuditCheck[];
  mode: BetterAuthAuditMode;
  status: "failed" | "passed";
};

export class BetterAuthAuditError extends TaggedError("BetterAuthAuditError")<{
  cause?: unknown;
  code: "database-query-failed" | "invalid-baseline";
  message: string;
}> {}

export type BetterAuthAuditDatabase = {
  execute: (statement: SQL) => Promise<unknown>;
};

type AuditRunResult = {
  baseline: BetterAuthAuditBaseline;
  report: BetterAuthAuditReport;
};

const queryRows = async (database: BetterAuthAuditDatabase, statement: SQL) => {
  const queried = await Result.tryPromise({
    try: async () => await database.execute(statement),
    catch: (cause) =>
      new BetterAuthAuditError({
        cause,
        code: "database-query-failed",
        message: "Better Auth audit database query failed",
      }),
  });
  if (Result.isError(queried)) {
    return queried;
  }
  let rows: unknown[] | null = null;
  if (Array.isArray(queried.value)) {
    rows = queried.value;
  } else if (isRecord(queried.value) && Array.isArray(queried.value["rows"])) {
    rows = queried.value["rows"];
  }
  if (rows === null) {
    return Result.err(
      new BetterAuthAuditError({
        code: "database-query-failed",
        message: "Better Auth audit database returned an invalid result",
      }),
    );
  }
  return Result.ok(rows);
};

const requiredString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const requiredBoolean = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

const tableInventoryStatement = sql`
  SELECT table_name AS "tableName"
    FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_type = 'BASE TABLE'
`;

const columnInventoryStatement = sql`
  SELECT table_name AS "tableName", column_name AS "columnName"
    FROM information_schema.columns
   WHERE table_schema = 'public'
`;

const PRIMARY_KEY_PAGE_SIZE = 1000;

const foreignKeyOrphanStatements = AUTH_TABLE_POLICIES.flatMap((policy) =>
  policy.foreignKeys.map(({ column, referencedColumn, referencedModel }) => {
    const referenced = AUTH_TABLE_AUDIT_POLICY[referencedModel];
    return sql`
      EXISTS (
        SELECT 1
          FROM ${sql.identifier(policy.tableName)} child
          LEFT JOIN ${sql.identifier(referenced.tableName)} parent
            ON child.${sql.identifier(column)} = parent.${sql.identifier(referencedColumn)}
         WHERE child.${sql.identifier(column)} IS NOT NULL
           AND parent.${sql.identifier(referencedColumn)} IS NULL
      )
    `;
  }),
);

const noForeignKeyOrphansStatement = sql`
  SELECT NOT (${sql.join(foreignKeyOrphanStatements, sql` OR `)}) AS "passed"
`;

const expectedForeignKeys = AUTH_TABLE_POLICIES.flatMap((policy) =>
  policy.foreignKeys.map(({ column, referencedColumn, referencedModel }) => {
    const referenced = AUTH_TABLE_AUDIT_POLICY[referencedModel];
    return sql`(
      ${policy.tableName}::text,
      ${column}::text,
      ${referenced.tableName}::text,
      ${referencedColumn}::text
    )`;
  }),
);

const foreignKeysValidatedStatement = sql`
  WITH expected(child_table, child_column, parent_table, parent_column) AS (
    VALUES ${sql.join(expectedForeignKeys, sql`, `)}
  )
  SELECT NOT EXISTS (
    SELECT 1
      FROM expected
     WHERE NOT EXISTS (
       SELECT 1
         FROM pg_constraint constraint_record
         JOIN pg_class child ON child.oid = constraint_record.conrelid
         JOIN pg_namespace child_namespace
           ON child_namespace.oid = child.relnamespace
         JOIN pg_class parent ON parent.oid = constraint_record.confrelid
         JOIN pg_namespace parent_namespace
           ON parent_namespace.oid = parent.relnamespace
         JOIN pg_attribute child_attribute
           ON child_attribute.attrelid = child.oid
          AND child_attribute.attnum = constraint_record.conkey[1]
         JOIN pg_attribute parent_attribute
           ON parent_attribute.attrelid = parent.oid
          AND parent_attribute.attnum = constraint_record.confkey[1]
        WHERE constraint_record.contype = 'f'
          AND constraint_record.convalidated
          AND cardinality(constraint_record.conkey) = 1
          AND cardinality(constraint_record.confkey) = 1
          AND child_namespace.nspname = 'public'
          AND parent_namespace.nspname = 'public'
          AND child.relname = expected.child_table
          AND child_attribute.attname = expected.child_column
          AND parent.relname = expected.parent_table
          AND parent_attribute.attname = expected.parent_column
     )
  ) AS "passed"
`;

const accessBoundariesStatement = (includeFutureTables: boolean) => {
  const policies: readonly AuthAccessPolicy[] = includeFutureTables
    ? [...Object.values(AUTH_ACCESS_POLICY), ...FUTURE_AUTH_ACCESS_POLICY]
    : Object.values(AUTH_ACCESS_POLICY);
  const expectedTables = policies.map(
    ({ access, tableName }) => sql`(${tableName}::text, ${access}::text)`,
  );
  const expectedPolicies = policies.flatMap(({ policyNames, tableName }) =>
    policyNames.map(
      (policyName) => sql`(${tableName}::text, ${policyName}::text)`,
    ),
  );
  return sql`
    WITH expected_tables(table_name, access) AS (
      VALUES ${sql.join(expectedTables, sql`, `)}
    ),
    expected_policies(table_name, policy_name) AS (
      VALUES ${sql.join(expectedPolicies, sql`, `)}
    )
    SELECT
      NOT EXISTS (
        SELECT 1
          FROM expected_tables expected
          LEFT JOIN pg_namespace namespace
            ON namespace.nspname = 'public'
          LEFT JOIN pg_class table_record
            ON table_record.relnamespace = namespace.oid
           AND table_record.relname = expected.table_name
         WHERE table_record.oid IS NULL OR NOT table_record.relrowsecurity
      )
      AND NOT EXISTS (
        SELECT 1
          FROM expected_policies expected
         WHERE NOT EXISTS (
           SELECT 1
             FROM pg_policies policy
            WHERE policy.schemaname = 'public'
              AND policy.tablename = expected.table_name
              AND policy.policyname = expected.policy_name
              AND policy.roles @> ARRAY['stella']::name[]
         )
      )
      AND NOT EXISTS (
        SELECT 1
          FROM expected_tables expected
         WHERE expected.access = 'denied'
           AND (
             has_table_privilege(
               'stella',
               format('%I.%I', 'public', expected.table_name),
               'SELECT'
             )
             OR has_table_privilege(
               'stella',
               format('%I.%I', 'public', expected.table_name),
               'INSERT'
             )
             OR has_table_privilege(
               'stella',
               format('%I.%I', 'public', expected.table_name),
               'UPDATE'
             )
             OR has_table_privilege(
               'stella',
               format('%I.%I', 'public', expected.table_name),
               'DELETE'
             )
             OR has_table_privilege(
               'stella',
               format('%I.%I', 'public', expected.table_name),
               'TRUNCATE'
             )
             OR has_table_privilege(
               'stella',
               format('%I.%I', 'public', expected.table_name),
               'REFERENCES'
             )
             OR has_table_privilege(
               'stella',
               format('%I.%I', 'public', expected.table_name),
               'TRIGGER'
             )
           )
      ) AS "passed"
  `;
};

const providersClassifiedStatement = sql`
  SELECT NOT EXISTS (
    SELECT 1
      FROM account
     WHERE provider_id NOT IN (
       ${AUTH_PROVIDER_IDS.CREDENTIAL},
       ${AUTH_PROVIDER_IDS.GOOGLE},
       ${AUTH_PROVIDER_IDS.MICROSOFT}
     )
  ) AS "passed"
`;

const credentialOwnershipStatement = sql`
  SELECT NOT EXISTS (
    SELECT 1
     FROM account
     WHERE provider_id = ${AUTH_PROVIDER_IDS.CREDENTIAL}
       AND account_id IS DISTINCT FROM user_id
  ) AS "passed"
`;

const accountIdentityCompleteStatement = sql`
  SELECT NOT EXISTS (
    SELECT 1
      FROM account
     WHERE issuer IS NULL
        OR issuer = ''
        OR account_id = ''
  ) AS "passed"
`;

const accountIdentityUniqueStatement = sql`
  SELECT NOT EXISTS (
    SELECT 1
      FROM account
     GROUP BY issuer, account_id
    HAVING count(*) > 1
  ) AS "passed"
`;

const accountIssuersTrustedStatement = sql`
  SELECT NOT EXISTS (
    SELECT 1
      FROM account
     WHERE (provider_id = ${AUTH_PROVIDER_IDS.CREDENTIAL}
            AND issuer IS DISTINCT FROM ${ACCOUNT_ISSUERS.CREDENTIAL})
        OR (provider_id = ${AUTH_PROVIDER_IDS.GOOGLE}
            AND issuer IS DISTINCT FROM ${ACCOUNT_ISSUERS.GOOGLE})
        OR (provider_id = ${AUTH_PROVIDER_IDS.MICROSOFT}
            AND (issuer NOT LIKE ${`${ACCOUNT_ISSUERS.MICROSOFT_PREFIX}%${ACCOUNT_ISSUERS.MICROSOFT_SUFFIX}`}
                 OR account_id IS NOT DISTINCT FROM user_id))
  ) AS "passed"
`;

const oauthClientResourceLinksStatement = sql`
  SELECT NOT EXISTS (
    SELECT 1
      FROM oauth_client client
     WHERE NOT EXISTS (
       SELECT 1
         FROM oauth_client_resource link
        WHERE link.client_id = client.client_id
     )
  ) AS "passed"
`;

const oauthClientsClassifiedStatement = sql`
  SELECT NOT EXISTS (
    SELECT 1
      FROM oauth_client
     WHERE application_type NOT IN ('web', 'native')
        OR application_type IS NULL
        OR client_credentials_scopes IS NULL
        OR token_endpoint_auth_method IS NULL
  ) AS "passed"
`;

const oauthResourceReferencesStatement = sql`
  SELECT NOT EXISTS (
    SELECT 1
      FROM oauth_client_resource link
      LEFT JOIN oauth_client client ON client.client_id = link.client_id
      LEFT JOIN oauth_resource resource ON resource.identifier = link.resource_id
     WHERE client.client_id IS NULL OR resource.identifier IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
      FROM oauth_access_token token
      CROSS JOIN LATERAL
        unnest(coalesce(token.resources, ARRAY[]::text[])) requested(identifier)
      LEFT JOIN oauth_resource resource
        ON resource.identifier = requested.identifier
      LEFT JOIN oauth_client_resource link
        ON link.client_id = token.client_id
       AND link.resource_id = requested.identifier
     WHERE resource.identifier IS NULL OR link.client_id IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
      FROM oauth_refresh_token token
      CROSS JOIN LATERAL
        unnest(coalesce(token.resources, ARRAY[]::text[])) requested(identifier)
      LEFT JOIN oauth_resource resource
        ON resource.identifier = requested.identifier
      LEFT JOIN oauth_client_resource link
        ON link.client_id = token.client_id
       AND link.resource_id = requested.identifier
     WHERE resource.identifier IS NULL OR link.client_id IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
      FROM oauth_consent consent
      CROSS JOIN LATERAL
        unnest(coalesce(consent.resources, ARRAY[]::text[])) requested(identifier)
      LEFT JOIN oauth_resource resource
        ON resource.identifier = requested.identifier
      LEFT JOIN oauth_client_resource link
        ON link.client_id = consent.client_id
       AND link.resource_id = requested.identifier
     WHERE resource.identifier IS NULL OR link.client_id IS NULL
  ) AS "passed"
`;

const finalAccountConstraintsStatement = sql`
  SELECT
    EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'account'
         AND column_name = 'issuer'
         AND is_nullable = 'NO'
    )
    AND EXISTS (
      SELECT 1
        FROM pg_index index_record
        JOIN pg_class table_record ON table_record.oid = index_record.indrelid
        JOIN pg_namespace namespace ON namespace.oid = table_record.relnamespace
       WHERE namespace.nspname = 'public'
         AND table_record.relname = 'account'
         AND index_record.indisunique
         AND index_record.indisvalid
         AND (
           SELECT array_agg(attribute.attname ORDER BY key_position.ordinality)
             FROM unnest(index_record.indkey) WITH ORDINALITY key_position(attnum, ordinality)
             JOIN pg_attribute attribute
               ON attribute.attrelid = table_record.oid
              AND attribute.attnum = key_position.attnum
         ) = ARRAY['issuer', 'account_id']::name[]
    ) AS "passed"
`;

const postMigrationConstraintsStatement = sql`
  SELECT
    EXISTS (
      SELECT 1
        FROM pg_index index_record
        JOIN pg_class table_record ON table_record.oid = index_record.indrelid
        JOIN pg_namespace namespace ON namespace.oid = table_record.relnamespace
       WHERE namespace.nspname = 'public'
         AND table_record.relname = ${FUTURE_AUTH_TABLES.OAUTH_CLIENT_RESOURCE}
         AND index_record.indisunique
         AND index_record.indisvalid
         AND (
           SELECT array_agg(attribute.attname ORDER BY key_position.ordinality)
             FROM unnest(index_record.indkey) WITH ORDINALITY key_position(attnum, ordinality)
             JOIN pg_attribute attribute
               ON attribute.attrelid = table_record.oid
              AND attribute.attnum = key_position.attnum
         ) = ARRAY['client_id', 'resource_id']::name[]
    )
    AND EXISTS (
      SELECT 1
        FROM pg_index index_record
        JOIN pg_class table_record ON table_record.oid = index_record.indrelid
        JOIN pg_namespace namespace ON namespace.oid = table_record.relnamespace
       WHERE namespace.nspname = 'public'
         AND table_record.relname = ${FUTURE_AUTH_TABLES.OAUTH_RESOURCE}
         AND index_record.indisunique
         AND index_record.indisvalid
         AND (
           SELECT array_agg(attribute.attname ORDER BY key_position.ordinality)
             FROM unnest(index_record.indkey) WITH ORDINALITY key_position(attnum, ordinality)
             JOIN pg_attribute attribute
               ON attribute.attrelid = table_record.oid
              AND attribute.attnum = key_position.attnum
         ) = ARRAY['identifier']::name[]
    )
    AND (
      SELECT count(*)
        FROM pg_constraint constraint_record
        JOIN pg_class child ON child.oid = constraint_record.conrelid
        JOIN pg_namespace namespace ON namespace.oid = child.relnamespace
       WHERE namespace.nspname = 'public'
         AND child.relname = ${FUTURE_AUTH_TABLES.OAUTH_CLIENT_RESOURCE}
         AND constraint_record.contype = 'f'
         AND constraint_record.convalidated
    ) = 2
    AND EXISTS (
      SELECT 1
        FROM pg_constraint constraint_record
        JOIN pg_class child ON child.oid = constraint_record.conrelid
        JOIN pg_namespace namespace ON namespace.oid = child.relnamespace
       WHERE namespace.nspname = 'public'
         AND child.relname = ${FUTURE_AUTH_TABLES.OAUTH_CLIENT_ASSERTION}
         AND constraint_record.contype = 'p'
         AND constraint_record.convalidated
    )
    AND NOT EXISTS (
      SELECT 1
        FROM pg_constraint constraint_record
        JOIN pg_class child ON child.oid = constraint_record.conrelid
        JOIN pg_namespace namespace ON namespace.oid = child.relnamespace
       WHERE namespace.nspname = 'public'
         AND child.relname IN (
           ${FUTURE_AUTH_TABLES.OAUTH_CLIENT_RESOURCE},
           ${FUTURE_AUTH_TABLES.OAUTH_CLIENT_ASSERTION}
         )
         AND constraint_record.contype IN ('p', 'f', 'u')
         AND NOT constraint_record.convalidated
    ) AS "passed"
`;

const booleanCheck = async (
  database: BetterAuthAuditDatabase,
  name: BetterAuthAuditCheckName,
  statement: SQL,
) => {
  const queried = await queryRows(database, statement);
  if (Result.isError(queried)) {
    return queried;
  }
  const row = queried.value.at(0);
  const passed = isRecord(row) ? requiredBoolean(row["passed"]) : null;
  if (passed === null) {
    return Result.err(
      new BetterAuthAuditError({
        code: "database-query-failed",
        message: "Better Auth audit check returned an invalid result",
      }),
    );
  }
  return Result.ok({ name, status: passed ? "passed" : "failed" } as const);
};

const tableInventory = async (database: BetterAuthAuditDatabase) => {
  const queried = await queryRows(database, tableInventoryStatement);
  if (Result.isError(queried)) {
    return queried;
  }
  const names = new Set<string>();
  for (const row of queried.value) {
    if (!isRecord(row)) {
      return Result.err(
        new BetterAuthAuditError({
          code: "database-query-failed",
          message: "Better Auth table inventory returned an invalid row",
        }),
      );
    }
    const name = requiredString(row["tableName"]);
    if (name === null) {
      return Result.err(
        new BetterAuthAuditError({
          code: "database-query-failed",
          message: "Better Auth table inventory returned an invalid name",
        }),
      );
    }
    names.add(name);
  }
  return Result.ok(names);
};

const columnInventory = async (database: BetterAuthAuditDatabase) => {
  const queried = await queryRows(database, columnInventoryStatement);
  if (Result.isError(queried)) {
    return queried;
  }
  const columns = new Set<string>();
  for (const row of queried.value) {
    if (!isRecord(row)) {
      return Result.err(
        new BetterAuthAuditError({
          code: "database-query-failed",
          message: "Better Auth column inventory returned an invalid row",
        }),
      );
    }
    const tableName = requiredString(row["tableName"]);
    const columnName = requiredString(row["columnName"]);
    if (tableName === null || columnName === null) {
      return Result.err(
        new BetterAuthAuditError({
          code: "database-query-failed",
          message: "Better Auth column inventory returned an invalid name",
        }),
      );
    }
    columns.add(`${tableName}.${columnName}`);
  }
  return Result.ok(columns);
};

type TableCensus = {
  primaryKeyDigest: string;
  rowContentDigest: string;
  rowCount: string;
};

const readTableCensus = async (
  database: BetterAuthAuditDatabase,
  policy: AuthTableAuditPolicy,
) => {
  const primaryKeyHasher = new Bun.CryptoHasher("sha256");
  const rowContentHasher = new Bun.CryptoHasher("sha256");
  const { preservedColumns, tableName } = policy;
  const preservedValues = preservedColumns.map((column) =>
    sql.identifier(column),
  );
  const readPage = async (
    after: string | null,
    rowCount: bigint,
  ): Promise<Result<TableCensus, BetterAuthAuditError>> => {
    const statement =
      after === null
        ? sql`
            SELECT id AS "primaryKey",
                   jsonb_build_array(${sql.join(preservedValues, sql`, `)})::text
                     AS "rowContent"
              FROM ${sql.identifier(tableName)}
             ORDER BY id
             LIMIT ${PRIMARY_KEY_PAGE_SIZE}
          `
        : sql`
            SELECT id AS "primaryKey",
                   jsonb_build_array(${sql.join(preservedValues, sql`, `)})::text
                     AS "rowContent"
              FROM ${sql.identifier(tableName)}
             WHERE id > ${after}
             ORDER BY id
             LIMIT ${PRIMARY_KEY_PAGE_SIZE}
          `;
    const queried = await queryRows(database, statement);
    if (Result.isError(queried)) {
      return queried;
    }
    let nextAfter = after;
    let nextRowCount = rowCount;
    for (const row of queried.value) {
      const primaryKey = isRecord(row)
        ? requiredString(row["primaryKey"])
        : null;
      const rowContent = isRecord(row)
        ? requiredString(row["rowContent"])
        : null;
      if (
        primaryKey === null ||
        rowContent === null ||
        (nextAfter !== null && primaryKey <= nextAfter)
      ) {
        return Result.err(
          new BetterAuthAuditError({
            code: "database-query-failed",
            message: "Better Auth primary-key census returned invalid data",
          }),
        );
      }
      // PostgreSQL text cannot contain NUL, so this delimiter makes the
      // ordered stream unambiguous without retaining identifiers in memory.
      primaryKeyHasher.update(primaryKey);
      primaryKeyHasher.update("\0");
      rowContentHasher.update(primaryKey);
      rowContentHasher.update("\0");
      rowContentHasher.update(rowContent);
      rowContentHasher.update("\0");
      nextAfter = primaryKey;
      nextRowCount += 1n;
    }
    if (queried.value.length < PRIMARY_KEY_PAGE_SIZE) {
      return Result.ok({
        primaryKeyDigest: primaryKeyHasher.digest("hex"),
        rowContentDigest: rowContentHasher.digest("hex"),
        rowCount: nextRowCount.toString(),
      });
    }
    return await readPage(nextAfter, nextRowCount);
  };

  return await readPage(null, 0n);
};

const readAuthCensus = async (database: BetterAuthAuditDatabase) => {
  const entries: BetterAuthAuditBaseline["tables"] = {};
  const readModel = async (
    index: number,
  ): Promise<
    Result<BetterAuthAuditBaseline["tables"], BetterAuthAuditError>
  > => {
    const model = AUTH_MODEL_NAMES.at(index);
    if (model === undefined) {
      return Result.ok(entries);
    }
    if (!isAuthModel(model)) {
      return Result.err(
        new BetterAuthAuditError({
          code: "database-query-failed",
          message: "Better Auth baseline policy contains an unknown model",
        }),
      );
    }
    const census = await readTableCensus(
      database,
      AUTH_TABLE_AUDIT_POLICY[model],
    );
    if (Result.isError(census)) {
      return census;
    }
    entries[model] = census.value;
    return await readModel(index + 1);
  };

  return await readModel(0);
};

const check = (
  name: BetterAuthAuditCheckName,
  passed: boolean,
): BetterAuthAuditCheck => ({
  name,
  status: passed ? "passed" : "failed",
});

const report = (
  mode: BetterAuthAuditMode,
  checks: readonly BetterAuthAuditCheck[],
): BetterAuthAuditReport => ({
  checks,
  mode,
  status: checks.every(({ status }) => status === "passed")
    ? "passed"
    : "failed",
});

const createBaseline = (tables: BetterAuthAuditBaseline["tables"]) => ({
  formatVersion: 1 as const,
  tables,
});

const emptyBaseline = (): BetterAuthAuditBaseline =>
  createBaseline(
    Object.fromEntries(
      AUTH_MODEL_NAMES.map((model) => [
        model,
        { primaryKeyDigest: "", rowContentDigest: "", rowCount: "0" },
      ]),
    ),
  );

type NamedAuditStatement = readonly [BetterAuthAuditCheckName, SQL];

const evaluateBooleanChecks = async (
  database: BetterAuthAuditDatabase,
  statements: readonly NamedAuditStatement[],
  checks: BetterAuthAuditCheck[],
  index = 0,
): Promise<Result<void, BetterAuthAuditError>> => {
  const statement = statements.at(index);
  if (statement === undefined) {
    return Result.ok(undefined);
  }
  const [name, query] = statement;
  const evaluated = await booleanCheck(database, name, query);
  if (Result.isError(evaluated)) {
    return evaluated;
  }
  checks.push(evaluated.value);
  return await evaluateBooleanChecks(database, statements, checks, index + 1);
};

type RunBetterAuthMigrationAuditOptions = {
  baseline: BetterAuthAuditBaseline | null;
  database: BetterAuthAuditDatabase;
  mode: BetterAuthAuditMode;
};

export const runBetterAuthMigrationAudit = async ({
  baseline,
  database,
  mode,
}: RunBetterAuthMigrationAuditOptions): Promise<
  Result<AuditRunResult, BetterAuthAuditError>
> => {
  const checks: BetterAuthAuditCheck[] = [];
  const tables = await tableInventory(database);
  if (Result.isError(tables)) {
    return tables;
  }

  const currentSchemaComplete = AUTH_TABLE_POLICIES.every(({ tableName }) =>
    tables.value.has(tableName),
  );
  checks.push(
    check(
      BETTER_AUTH_AUDIT_CHECKS.CURRENT_SCHEMA_COMPLETE,
      currentSchemaComplete,
    ),
  );
  if (!currentSchemaComplete) {
    return Result.ok({
      baseline: emptyBaseline(),
      report: report(mode, checks),
    });
  }

  if (mode !== BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION) {
    const columns = await columnInventory(database);
    if (Result.isError(columns)) {
      return columns;
    }
    const futureTablesComplete = Object.values(FUTURE_AUTH_TABLES).every(
      (tableName) => tables.value.has(tableName),
    );
    const futureColumnsComplete = Object.entries(POST_BACKFILL_COLUMNS).every(
      ([tableName, requiredColumns]) =>
        requiredColumns.every((column) =>
          columns.value.has(`${tableName}.${column}`),
        ),
    );
    const postBackfillSchemaComplete =
      futureTablesComplete && futureColumnsComplete;
    checks.push(
      check(
        BETTER_AUTH_AUDIT_CHECKS.POST_BACKFILL_SCHEMA_COMPLETE,
        postBackfillSchemaComplete,
      ),
    );
    if (!postBackfillSchemaComplete) {
      return Result.ok({
        baseline: emptyBaseline(),
        report: report(mode, checks),
      });
    }
  }

  const accessBoundaries = await booleanCheck(
    database,
    BETTER_AUTH_AUDIT_CHECKS.AUTH_ACCESS_BOUNDARIES,
    accessBoundariesStatement(mode !== BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION),
  );
  if (Result.isError(accessBoundaries)) {
    return accessBoundaries;
  }
  checks.push(accessBoundaries.value);

  const commonChecks = [
    [
      BETTER_AUTH_AUDIT_CHECKS.AUTH_FOREIGN_KEYS_REACHABLE,
      noForeignKeyOrphansStatement,
    ],
    [
      BETTER_AUTH_AUDIT_CHECKS.AUTH_FOREIGN_KEYS_VALIDATED,
      foreignKeysValidatedStatement,
    ],
    [
      BETTER_AUTH_AUDIT_CHECKS.ACCOUNT_PROVIDERS_CLASSIFIED,
      providersClassifiedStatement,
    ],
    [
      BETTER_AUTH_AUDIT_CHECKS.CREDENTIAL_ACCOUNT_OWNERSHIP,
      credentialOwnershipStatement,
    ],
  ] as const;
  const commonChecksEvaluated = await evaluateBooleanChecks(
    database,
    commonChecks,
    checks,
  );
  if (Result.isError(commonChecksEvaluated)) {
    return commonChecksEvaluated;
  }

  if (mode !== BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION) {
    const postBackfillChecks = [
      [
        BETTER_AUTH_AUDIT_CHECKS.ACCOUNT_IDENTITY_COMPLETE,
        accountIdentityCompleteStatement,
      ],
      [
        BETTER_AUTH_AUDIT_CHECKS.ACCOUNT_IDENTITY_UNIQUE,
        accountIdentityUniqueStatement,
      ],
      [
        BETTER_AUTH_AUDIT_CHECKS.ACCOUNT_ISSUERS_TRUSTED,
        accountIssuersTrustedStatement,
      ],
      [
        BETTER_AUTH_AUDIT_CHECKS.OAUTH_CLIENT_RESOURCE_LINKS,
        oauthClientResourceLinksStatement,
      ],
      [
        BETTER_AUTH_AUDIT_CHECKS.OAUTH_CLIENTS_CLASSIFIED,
        oauthClientsClassifiedStatement,
      ],
      [
        BETTER_AUTH_AUDIT_CHECKS.OAUTH_RESOURCE_REFERENCES,
        oauthResourceReferencesStatement,
      ],
    ] as const;
    const postBackfillChecksEvaluated = await evaluateBooleanChecks(
      database,
      postBackfillChecks,
      checks,
    );
    if (Result.isError(postBackfillChecksEvaluated)) {
      return postBackfillChecksEvaluated;
    }
  }

  if (mode === BETTER_AUTH_AUDIT_MODES.POST_MIGRATION) {
    const columns = await columnInventory(database);
    if (Result.isError(columns)) {
      return columns;
    }
    checks.push(
      check(
        BETTER_AUTH_AUDIT_CHECKS.FINAL_SCHEMA_COMPLETE,
        Object.entries(POST_MIGRATION_COLUMNS).every(
          ([tableName, requiredColumns]) =>
            requiredColumns.every((column) =>
              columns.value.has(`${tableName}.${column}`),
            ),
        ),
      ),
    );
    const postMigrationChecks = [
      [
        BETTER_AUTH_AUDIT_CHECKS.FINAL_ACCOUNT_CONSTRAINTS,
        finalAccountConstraintsStatement,
      ],
      [
        BETTER_AUTH_AUDIT_CHECKS.POST_MIGRATION_CONSTRAINTS,
        postMigrationConstraintsStatement,
      ],
    ] as const;
    const postMigrationChecksEvaluated = await evaluateBooleanChecks(
      database,
      postMigrationChecks,
      checks,
    );
    if (Result.isError(postMigrationChecksEvaluated)) {
      return postMigrationChecksEvaluated;
    }
  }

  const census = await readAuthCensus(database);
  if (Result.isError(census)) {
    return census;
  }
  const nextBaseline = createBaseline(census.value);
  if (mode === BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION) {
    checks.push(check(BETTER_AUTH_AUDIT_CHECKS.AUTH_ROWS_BASELINED, true));
  } else {
    const preserved =
      baseline !== null &&
      AUTH_MODEL_NAMES.every((model) => {
        const expected = baseline.tables[model];
        const actual = census.value[model];
        return (
          expected !== undefined &&
          actual !== undefined &&
          expected.rowCount === actual.rowCount &&
          expected.primaryKeyDigest === actual.primaryKeyDigest &&
          expected.rowContentDigest === actual.rowContentDigest
        );
      });
    checks.push(check(BETTER_AUTH_AUDIT_CHECKS.AUTH_ROWS_PRESERVED, preserved));
  }

  const expectedCheckNames = CHECKS_BY_MODE[mode];
  const evaluatedByName = new Set(checks.map(({ name }) => name));
  if (expectedCheckNames.some((name) => !evaluatedByName.has(name))) {
    return Result.err(
      new BetterAuthAuditError({
        code: "database-query-failed",
        message: "Better Auth audit mode omitted a required check",
      }),
    );
  }

  return Result.ok({ baseline: nextBaseline, report: report(mode, checks) });
};

export const parseBetterAuthAuditBaseline = (
  value: unknown,
): Result<BetterAuthAuditBaseline, BetterAuthAuditError> => {
  if (!isRecord(value) || value["formatVersion"] !== 1) {
    return Result.err(
      new BetterAuthAuditError({
        code: "invalid-baseline",
        message: "Better Auth audit baseline is invalid",
      }),
    );
  }
  const rawTables = value["tables"];
  if (!isRecord(rawTables)) {
    return Result.err(
      new BetterAuthAuditError({
        code: "invalid-baseline",
        message: "Better Auth audit baseline is invalid",
      }),
    );
  }
  const keys = Object.keys(rawTables);
  if (
    keys.length !== AUTH_MODEL_NAMES.length ||
    AUTH_MODEL_NAMES.some((model) => {
      const table = rawTables[model];
      return (
        !isRecord(table) ||
        Object.keys(table).length !== 3 ||
        !/^\d+$/u.test(requiredString(table["rowCount"]) ?? "") ||
        !/^[a-f\d]{64}$/u.test(
          requiredString(table["primaryKeyDigest"]) ?? "",
        ) ||
        !/^[a-f\d]{64}$/u.test(requiredString(table["rowContentDigest"]) ?? "")
      );
    })
  ) {
    return Result.err(
      new BetterAuthAuditError({
        code: "invalid-baseline",
        message: "Better Auth audit baseline is invalid",
      }),
    );
  }
  return Result.ok({
    formatVersion: 1,
    tables: Object.fromEntries(
      AUTH_MODEL_NAMES.map((model) => {
        const table = rawTables[model];
        if (!isRecord(table)) {
          return [
            model,
            { primaryKeyDigest: "", rowContentDigest: "", rowCount: "" },
          ];
        }
        return [
          model,
          {
            primaryKeyDigest: requiredString(table["primaryKeyDigest"]) ?? "",
            rowContentDigest: requiredString(table["rowContentDigest"]) ?? "",
            rowCount: requiredString(table["rowCount"]) ?? "",
          },
        ];
      }),
    ),
  });
};

export const renderBetterAuthAuditReport = (
  value: BetterAuthAuditReport,
): string => `${JSON.stringify(value)}\n`;
