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
import * as v from "valibot";

import { authSchema } from "@/api/db/auth-schema";
import { compareCodepoint } from "@/api/lib/collation";
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

const TRANSFORMED_ACCOUNT_COLUMNS = new Set(["issuer"]);
const INTRODUCED_OAUTH_COLUMNS = {
  oauthAccessToken: new Set([
    "authorization_code_id",
    "confirmation",
    "requested_user_info_claims",
    "resources",
    "revoked",
  ]),
  oauthClient: new Set([
    "application_type",
    "backchannel_logout_session_required",
    "backchannel_logout_uri",
    "client_credentials_scopes",
    "client_discovery_id",
    "dpop_bound_access_tokens",
    "jwks",
    "jwks_uri",
  ]),
  oauthConsent: new Set(["requested_user_info_claims", "resources"]),
  oauthRefreshToken: new Set([
    "authorization_code_id",
    "confirmation",
    "requested_user_info_claims",
    "resources",
    "rotated_at",
    "rotation_replay_expires_at",
    "rotation_replay_response",
  ]),
} as const;
const MICROSOFT_ACCOUNT_ID_CENSUS_SENTINEL =
  "better-auth-1.7-trusted-microsoft-identity";

const preservedAccountColumnNames = () =>
  columnNames(authSchema.account).filter(
    (column) => !TRANSFORMED_ACCOUNT_COLUMNS.has(column),
  );

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
  policies: readonly AuthPolicyRule[];
  tableName: string;
};

type AuthPolicyRule = {
  command: "ALL" | "SELECT" | "UPDATE";
  name: string;
  predicate: "deny" | "scoped-read" | "scoped-write";
};

const columnNames = (table: Table) =>
  Object.values(getColumns(table)).map(({ name }) => name);

const preservedColumnNames = (table: Table, introduced: ReadonlySet<string>) =>
  columnNames(table).filter((column) => !introduced.has(column));

/**
 * Total by construction: adding a table to `authSchema` fails typechecking
 * until its preservation and reachability policy is chosen here.
 */
export const AUTH_TABLE_AUDIT_POLICY = {
  account: {
    foreignKeys: [
      { column: "user_id", referencedColumn: "id", referencedModel: "user" },
    ],
    // Better Auth 1.7 adds issuer. Microsoft account_id deliberately changes
    // from sub to a verified oid, so the census masks only that provider's
    // value while preserving Google and credential account IDs byte-for-byte.
    // The trusted identity projection below owns the Microsoft transition.
    preservedColumns: preservedAccountColumnNames(),
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
    preservedColumns: preservedColumnNames(
      authSchema.oauthAccessToken,
      INTRODUCED_OAUTH_COLUMNS.oauthAccessToken,
    ),
    tableName: getTableName(authSchema.oauthAccessToken),
  },
  oauthClient: {
    foreignKeys: [
      { column: "user_id", referencedColumn: "id", referencedModel: "user" },
    ],
    preservedColumns: preservedColumnNames(
      authSchema.oauthClient,
      INTRODUCED_OAUTH_COLUMNS.oauthClient,
    ),
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
    preservedColumns: preservedColumnNames(
      authSchema.oauthConsent,
      INTRODUCED_OAUTH_COLUMNS.oauthConsent,
    ),
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
    preservedColumns: preservedColumnNames(
      authSchema.oauthRefreshToken,
      INTRODUCED_OAUTH_COLUMNS.oauthRefreshToken,
    ),
    tableName: getTableName(authSchema.oauthRefreshToken),
  },
  organization: {
    foreignKeys: [],
    preservedColumns: columnNames(authSchema.organization),
    tableName: getTableName(authSchema.organization),
  },
  oauthClientAssertion: {
    foreignKeys: [],
    preservedColumns: columnNames(authSchema.oauthClientAssertion),
    tableName: getTableName(authSchema.oauthClientAssertion),
  },
  oauthClientResource: {
    foreignKeys: [
      {
        column: "client_id",
        referencedColumn: "client_id",
        referencedModel: "oauthClient",
      },
      {
        column: "resource_id",
        referencedColumn: "identifier",
        referencedModel: "oauthResource",
      },
    ],
    preservedColumns: columnNames(authSchema.oauthClientResource),
    tableName: getTableName(authSchema.oauthClientResource),
  },
  oauthResource: {
    foreignKeys: [],
    preservedColumns: columnNames(authSchema.oauthResource),
    tableName: getTableName(authSchema.oauthResource),
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

const isAuthModel = (value: string): value is AuthModel =>
  Object.hasOwn(AUTH_TABLE_AUDIT_POLICY, value);

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
  oauthClientAssertion: "introduced",
  oauthClientResource: "introduced",
  oauthConsent: "preserve",
  oauthRefreshToken: "preserve",
  oauthResource: "introduced",
  organization: "preserve",
  session: "preserve",
  twoFactor: "preserve",
  user: "preserve",
  verification: "preserve",
} as const satisfies Record<AuthModel, "introduced" | "preserve">;

const isPreservedDisposition = (value: "introduced" | "preserve") =>
  value === "preserve";

export const AUTH_BASELINE_MODEL_NAMES = Object.keys(AUTH_BASELINE_DISPOSITION)
  .filter(isAuthModel)
  .filter((model) => isPreservedDisposition(AUTH_BASELINE_DISPOSITION[model]));
const AUTH_TABLE_POLICIES = Object.values(AUTH_TABLE_AUDIT_POLICY);

const PRESERVED_AUTH_TABLE_NAMES = AUTH_BASELINE_MODEL_NAMES.flatMap((model) =>
  isAuthModel(model) ? [AUTH_TABLE_AUDIT_POLICY[model].tableName] : [],
);

const AUTH_ACCESS_POLICY = {
  account: {
    access: "denied",
    policies: [
      {
        command: "ALL",
        name: "auth_no_stella_access",
        predicate: "deny",
      },
    ],
    tableName: AUTH_TABLE_AUDIT_POLICY.account.tableName,
  },
  apikey: {
    access: "denied",
    policies: [
      {
        command: "ALL",
        name: "auth_no_stella_access",
        predicate: "deny",
      },
    ],
    tableName: AUTH_TABLE_AUDIT_POLICY.apikey.tableName,
  },
  invitation: {
    access: "denied",
    policies: [
      {
        command: "ALL",
        name: "auth_no_stella_access",
        predicate: "deny",
      },
    ],
    tableName: AUTH_TABLE_AUDIT_POLICY.invitation.tableName,
  },
  jwks: {
    access: "denied",
    policies: [
      {
        command: "ALL",
        name: "auth_no_stella_access",
        predicate: "deny",
      },
    ],
    tableName: AUTH_TABLE_AUDIT_POLICY.jwks.tableName,
  },
  member: {
    access: "scoped",
    policies: [
      {
        command: "SELECT",
        name: "auth_member_select",
        predicate: "scoped-read",
      },
      {
        command: "UPDATE",
        name: "auth_member_update_last_active_workspace",
        predicate: "scoped-write",
      },
    ],
    tableName: AUTH_TABLE_AUDIT_POLICY.member.tableName,
  },
  oauthAccessToken: {
    access: "denied",
    policies: [
      {
        command: "ALL",
        name: "auth_no_stella_access",
        predicate: "deny",
      },
    ],
    tableName: AUTH_TABLE_AUDIT_POLICY.oauthAccessToken.tableName,
  },
  oauthClient: {
    access: "denied",
    policies: [
      {
        command: "ALL",
        name: "auth_no_stella_access",
        predicate: "deny",
      },
    ],
    tableName: AUTH_TABLE_AUDIT_POLICY.oauthClient.tableName,
  },
  oauthClientAssertion: {
    access: "denied",
    policies: [
      {
        command: "ALL",
        name: "auth_no_stella_access",
        predicate: "deny",
      },
    ],
    tableName: AUTH_TABLE_AUDIT_POLICY.oauthClientAssertion.tableName,
  },
  oauthClientResource: {
    access: "denied",
    policies: [
      {
        command: "ALL",
        name: "auth_no_stella_access",
        predicate: "deny",
      },
    ],
    tableName: AUTH_TABLE_AUDIT_POLICY.oauthClientResource.tableName,
  },
  oauthConsent: {
    access: "denied",
    policies: [
      {
        command: "ALL",
        name: "auth_no_stella_access",
        predicate: "deny",
      },
    ],
    tableName: AUTH_TABLE_AUDIT_POLICY.oauthConsent.tableName,
  },
  oauthRefreshToken: {
    access: "denied",
    policies: [
      {
        command: "ALL",
        name: "auth_no_stella_access",
        predicate: "deny",
      },
    ],
    tableName: AUTH_TABLE_AUDIT_POLICY.oauthRefreshToken.tableName,
  },
  oauthResource: {
    access: "denied",
    policies: [
      {
        command: "ALL",
        name: "auth_no_stella_access",
        predicate: "deny",
      },
    ],
    tableName: AUTH_TABLE_AUDIT_POLICY.oauthResource.tableName,
  },
  organization: {
    access: "scoped",
    policies: [
      {
        command: "SELECT",
        name: "auth_organization_select",
        predicate: "scoped-read",
      },
    ],
    tableName: AUTH_TABLE_AUDIT_POLICY.organization.tableName,
  },
  session: {
    access: "denied",
    policies: [
      {
        command: "ALL",
        name: "auth_no_stella_access",
        predicate: "deny",
      },
    ],
    tableName: AUTH_TABLE_AUDIT_POLICY.session.tableName,
  },
  twoFactor: {
    access: "denied",
    policies: [
      {
        command: "ALL",
        name: "auth_no_stella_access",
        predicate: "deny",
      },
    ],
    tableName: AUTH_TABLE_AUDIT_POLICY.twoFactor.tableName,
  },
  user: {
    access: "scoped",
    policies: [
      {
        command: "SELECT",
        name: "auth_user_select",
        predicate: "scoped-read",
      },
    ],
    tableName: AUTH_TABLE_AUDIT_POLICY.user.tableName,
  },
  verification: {
    access: "denied",
    policies: [
      {
        command: "ALL",
        name: "auth_no_stella_access",
        predicate: "deny",
      },
    ],
    tableName: AUTH_TABLE_AUDIT_POLICY.verification.tableName,
  },
} as const satisfies Record<AuthModel, AuthAccessPolicy>;

const FUTURE_AUTH_TABLES = {
  OAUTH_CLIENT_ASSERTION: "oauth_client_assertion",
  OAUTH_CLIENT_RESOURCE: "oauth_client_resource",
  OAUTH_RESOURCE: "oauth_resource",
} as const;

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
  ACCOUNT_IDENTITY_MAPPING_COMPLETE: "account-identity-mapping-complete",
  ACCOUNT_IDENTITY_PROJECTED_UNIQUE: "account-identity-projected-unique",
  ACCOUNT_IDENTITIES_MATCH_TRUSTED_PROJECTION:
    "account-identities-match-trusted-projection",
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
  OAUTH_POLICY_MATCHES_TRUSTED_PROJECTION:
    "oauth-policy-matches-trusted-projection",
  OAUTH_POLICY_PROJECTED_VALID: "oauth-policy-projected-valid",
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
    BETTER_AUTH_AUDIT_CHECKS.ACCOUNT_IDENTITY_MAPPING_COMPLETE,
    BETTER_AUTH_AUDIT_CHECKS.ACCOUNT_IDENTITY_PROJECTED_UNIQUE,
    BETTER_AUTH_AUDIT_CHECKS.OAUTH_POLICY_PROJECTED_VALID,
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
    BETTER_AUTH_AUDIT_CHECKS.ACCOUNT_IDENTITIES_MATCH_TRUSTED_PROJECTION,
    BETTER_AUTH_AUDIT_CHECKS.OAUTH_POLICY_MATCHES_TRUSTED_PROJECTION,
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
    BETTER_AUTH_AUDIT_CHECKS.ACCOUNT_IDENTITIES_MATCH_TRUSTED_PROJECTION,
    BETTER_AUTH_AUDIT_CHECKS.OAUTH_POLICY_MATCHES_TRUSTED_PROJECTION,
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
  accountIdentityProjection: {
    digest: string;
    rowCount: string;
  };
  accessPolicyDigest: string;
  formatVersion: 4;
  oauthPolicyProjection: {
    clientCount: string;
    digest: string;
    resourceCount: string;
  };
  tables: Record<
    string,
    {
      preservedColumns: readonly string[];
      primaryKeyDigest: string;
      rowContentDigest: string;
      rowCount: string;
    }
  >;
};

export type BetterAuthTrustedIdentityMap = {
  formatVersion: 1;
  microsoftAccounts: readonly {
    accountId: string;
    accountRowId: string;
    issuer: string;
    legacyAccountId: string;
  }[];
};

export type BetterAuthExpectedOAuthResource = {
  allowedScopes: readonly string[];
  identifier: string;
  name: string;
};

export type BetterAuthAuditReport = {
  checks: readonly BetterAuthAuditCheck[];
  mode: BetterAuthAuditMode;
  status: "failed" | "passed";
};

export class BetterAuthAuditError extends TaggedError("BetterAuthAuditError")<{
  cause?: unknown;
  code: "database-query-failed" | "invalid-baseline" | "invalid-identity-map";
  message: string;
}> {}

export type BetterAuthAuditDatabase = {
  execute: (statement: SQL) => Promise<unknown>;
};

type AuditRunResult = {
  baseline: BetterAuthAuditBaseline;
  report: BetterAuthAuditReport;
};

type AuditRowsResult = Result<unknown[], BetterAuthAuditError>;

const queryRows = async (
  database: BetterAuthAuditDatabase,
  statement: SQL,
): Promise<AuditRowsResult> => {
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

const requiredStringArray = (value: unknown): readonly string[] | null =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : null;

const optionalStringArray = (value: unknown): readonly string[] | null =>
  value === null ? [] : requiredStringArray(value);

type AccountIdentityProjection = {
  collisionFree: boolean;
  digest: string;
  mappingComplete: boolean;
  rowCount: string;
};

const ACCOUNT_IDENTITY_PAGE_SIZE = 1000;

const accountIdentityKeyDigest = (issuer: string, accountId: string) => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(issuer);
  hasher.update("\0");
  hasher.update(accountId);
  return hasher.digest("hex");
};

const updateAccountIdentityProjection = (
  hasher: Bun.CryptoHasher,
  accountRowId: string,
  issuer: string,
  accountId: string,
) => {
  hasher.update(accountRowId);
  hasher.update("\0");
  hasher.update(issuer);
  hasher.update("\0");
  hasher.update(accountId);
  hasher.update("\0");
};

const readProjectedAccountIdentities = async (
  database: BetterAuthAuditDatabase,
  trustedIdentityMap: BetterAuthTrustedIdentityMap,
) => {
  const microsoftByAccountRowId = new Map(
    trustedIdentityMap.microsoftAccounts.map((identity) => [
      identity.accountRowId,
      identity,
    ]),
  );
  let mappingComplete =
    microsoftByAccountRowId.size ===
    trustedIdentityMap.microsoftAccounts.length;
  const seenMicrosoftAccountRowIds = new Set<string>();
  const projectionHasher = new Bun.CryptoHasher("sha256");
  const microsoftIdentityKeys = new Set(
    trustedIdentityMap.microsoftAccounts.map(({ accountId, issuer }) =>
      accountIdentityKeyDigest(issuer, accountId),
    ),
  );
  const collisionFree =
    microsoftIdentityKeys.size === trustedIdentityMap.microsoftAccounts.length;
  let after: string | null = null;
  let rowCount = 0n;

  const readNextPage = async (): Promise<
    Result<void, BetterAuthAuditError>
  > => {
    const statement =
      after === null
        ? sql`
            SELECT id AS "accountRowId",
                   account_id AS "accountId",
                   provider_id AS "providerId",
                   user_id AS "userId"
              FROM account
             ORDER BY id
             LIMIT ${ACCOUNT_IDENTITY_PAGE_SIZE}
          `
        : sql`
            SELECT id AS "accountRowId",
                   account_id AS "accountId",
                   provider_id AS "providerId",
                   user_id AS "userId"
              FROM account
             WHERE id > ${after}
             ORDER BY id
             LIMIT ${ACCOUNT_IDENTITY_PAGE_SIZE}
          `;
    const queried = await queryRows(database, statement);
    if (Result.isError(queried)) {
      return Result.err(queried.error);
    }

    for (const row of queried.value) {
      const accountRowId = isRecord(row)
        ? requiredString(row["accountRowId"])
        : null;
      const currentAccountId = isRecord(row)
        ? requiredString(row["accountId"])
        : null;
      const providerId = isRecord(row)
        ? requiredString(row["providerId"])
        : null;
      const userId = isRecord(row) ? requiredString(row["userId"]) : null;
      if (
        accountRowId === null ||
        currentAccountId === null ||
        providerId === null ||
        userId === null
      ) {
        return Result.err(
          new BetterAuthAuditError({
            code: "database-query-failed",
            message:
              "Better Auth account identity projection returned invalid data",
          }),
        );
      }

      let projectedIssuer = "local:invalid";
      let projectedAccountId = currentAccountId;
      const microsoftIdentity = microsoftByAccountRowId.get(accountRowId);
      switch (providerId) {
        case AUTH_PROVIDER_IDS.CREDENTIAL:
          projectedIssuer = ACCOUNT_ISSUERS.CREDENTIAL;
          projectedAccountId = userId;
          if (microsoftIdentity !== undefined) {
            mappingComplete = false;
          }
          break;
        case AUTH_PROVIDER_IDS.GOOGLE:
          projectedIssuer = ACCOUNT_ISSUERS.GOOGLE;
          if (microsoftIdentity !== undefined) {
            mappingComplete = false;
          }
          break;
        case AUTH_PROVIDER_IDS.MICROSOFT:
          if (
            microsoftIdentity === undefined ||
            microsoftIdentity.legacyAccountId !== currentAccountId
          ) {
            mappingComplete = false;
            break;
          }
          seenMicrosoftAccountRowIds.add(accountRowId);
          projectedIssuer = microsoftIdentity.issuer;
          projectedAccountId = microsoftIdentity.accountId;
          break;
        default:
          mappingComplete = false;
      }

      updateAccountIdentityProjection(
        projectionHasher,
        accountRowId,
        projectedIssuer,
        projectedAccountId,
      );
      after = accountRowId;
      rowCount += 1n;
    }
    return queried.value.length < ACCOUNT_IDENTITY_PAGE_SIZE
      ? Result.ok(undefined)
      : readNextPage();
  };
  const pagesRead = await readNextPage();
  if (Result.isError(pagesRead)) {
    return Result.err(pagesRead.error);
  }

  if (
    seenMicrosoftAccountRowIds.size !==
    trustedIdentityMap.microsoftAccounts.length
  ) {
    mappingComplete = false;
  }

  return Result.ok({
    collisionFree,
    digest: projectionHasher.digest("hex"),
    mappingComplete,
    rowCount: rowCount.toString(),
  } satisfies AccountIdentityProjection);
};

const readActualAccountIdentities = async (
  database: BetterAuthAuditDatabase,
) => {
  const projectionHasher = new Bun.CryptoHasher("sha256");
  let after: string | null = null;
  let rowCount = 0n;

  const readNextPage = async (): Promise<
    Result<void, BetterAuthAuditError>
  > => {
    const statement =
      after === null
        ? sql`
            SELECT id AS "accountRowId",
                   issuer,
                   account_id AS "accountId"
              FROM account
             ORDER BY id
             LIMIT ${ACCOUNT_IDENTITY_PAGE_SIZE}
          `
        : sql`
            SELECT id AS "accountRowId",
                   issuer,
                   account_id AS "accountId"
              FROM account
             WHERE id > ${after}
             ORDER BY id
             LIMIT ${ACCOUNT_IDENTITY_PAGE_SIZE}
          `;
    const queried = await queryRows(database, statement);
    if (Result.isError(queried)) {
      return Result.err(queried.error);
    }
    for (const row of queried.value) {
      const accountRowId = isRecord(row)
        ? requiredString(row["accountRowId"])
        : null;
      const issuer = isRecord(row) ? requiredString(row["issuer"]) : null;
      const accountId = isRecord(row) ? requiredString(row["accountId"]) : null;
      if (accountRowId === null || issuer === null || accountId === null) {
        return Result.err(
          new BetterAuthAuditError({
            code: "database-query-failed",
            message:
              "Better Auth account identity census returned invalid data",
          }),
        );
      }
      updateAccountIdentityProjection(
        projectionHasher,
        accountRowId,
        issuer,
        accountId,
      );
      after = accountRowId;
      rowCount += 1n;
    }
    return queried.value.length < ACCOUNT_IDENTITY_PAGE_SIZE
      ? Result.ok(undefined)
      : readNextPage();
  };
  const pagesRead = await readNextPage();
  if (Result.isError(pagesRead)) {
    return Result.err(pagesRead.error);
  }
  return Result.ok({
    digest: projectionHasher.digest("hex"),
    rowCount: rowCount.toString(),
  });
};

type OAuthPolicyProjection =
  BetterAuthAuditBaseline["oauthPolicyProjection"] & {
    valid: boolean;
  };

const OAUTH_POLICY_PAGE_SIZE = 1000;
// A client registered without an application type is treated by the provider
// as a web client; the audit and backfill project the same default so the
// stored policy matches the provider's own reading of the row.
export const DEFAULT_OAUTH_APPLICATION_TYPE = "web";

// Only a genuine SQL NULL takes the default; an absent or malformed value
// stays invalid so validation still rejects it.
export const readOAuthApplicationType = (row: Record<string, unknown>) =>
  row["applicationType"] === null
    ? DEFAULT_OAUTH_APPLICATION_TYPE
    : requiredString(row["applicationType"]);

const OAUTH_PROTOCOL_SCOPES = new Set([
  "email",
  "offline_access",
  "openid",
  "profile",
]);

const updateOAuthPolicyValue = (
  hasher: Bun.CryptoHasher,
  values: readonly string[],
) => {
  for (const value of values) {
    hasher.update(value);
    hasher.update("\0");
  }
};

const sortedUnique = (values: readonly string[]) =>
  [...new Set(values)].toSorted();

const initializeOAuthPolicyProjection = (
  expectedResources: readonly BetterAuthExpectedOAuthResource[],
) => {
  const hasher = new Bun.CryptoHasher("sha256");
  const sortedResources = [...expectedResources].toSorted((left, right) =>
    compareCodepoint(left.identifier, right.identifier),
  );
  let valid =
    sortedResources.length > 0 &&
    new Set(sortedResources.map(({ identifier }) => identifier)).size ===
      sortedResources.length;
  for (const resource of sortedResources) {
    const scopes = sortedUnique(resource.allowedScopes);
    valid &&=
      resource.identifier.length > 0 &&
      resource.name.length > 0 &&
      scopes.length > 0 &&
      scopes.length === resource.allowedScopes.length;
    updateOAuthPolicyValue(hasher, [
      "resource",
      resource.identifier,
      resource.name,
      ...scopes,
    ]);
  }
  return { hasher, resourceCount: BigInt(sortedResources.length), valid };
};

const readProjectedOAuthPolicy = async (
  database: BetterAuthAuditDatabase,
  expectedResources: readonly BetterAuthExpectedOAuthResource[],
) => {
  const initialized = initializeOAuthPolicyProjection(expectedResources);
  const resourceIdentifiers = expectedResources
    .map(({ identifier }) => identifier)
    .toSorted();
  let after: string | null = null;
  let clientCount = 0n;
  let valid = initialized.valid;

  const readNextPage = async (): Promise<
    Result<void, BetterAuthAuditError>
  > => {
    const statement =
      after === null
        ? sql`
            SELECT client_id AS "clientId",
                   type AS "applicationType",
                   scopes,
                   grant_types AS "grantTypes"
              FROM oauth_client
             ORDER BY client_id
             LIMIT ${OAUTH_POLICY_PAGE_SIZE}
          `
        : sql`
            SELECT client_id AS "clientId",
                   type AS "applicationType",
                   scopes,
                   grant_types AS "grantTypes"
              FROM oauth_client
             WHERE client_id > ${after}
             ORDER BY client_id
             LIMIT ${OAUTH_POLICY_PAGE_SIZE}
          `;
    const queried = await queryRows(database, statement);
    if (Result.isError(queried)) {
      return Result.err(queried.error);
    }
    for (const row of queried.value) {
      const clientId = isRecord(row) ? requiredString(row["clientId"]) : null;
      const applicationType = isRecord(row)
        ? readOAuthApplicationType(row)
        : null;
      const scopes = isRecord(row) ? optionalStringArray(row["scopes"]) : null;
      const grantTypes = isRecord(row)
        ? optionalStringArray(row["grantTypes"])
        : null;
      if (clientId === null || scopes === null || grantTypes === null) {
        return Result.err(
          new BetterAuthAuditError({
            code: "database-query-failed",
            message:
              "Better Auth OAuth policy projection returned invalid data",
          }),
        );
      }
      const classifiedApplicationType =
        applicationType === "native" || applicationType === "web"
          ? applicationType
          : "invalid";
      valid &&= classifiedApplicationType !== "invalid";
      const clientCredentialsScopes = grantTypes.includes("client_credentials")
        ? sortedUnique(
            scopes.filter((scope) => !OAUTH_PROTOCOL_SCOPES.has(scope)),
          )
        : [];
      updateOAuthPolicyValue(initialized.hasher, [
        "client",
        clientId,
        classifiedApplicationType,
        ...clientCredentialsScopes,
        "resources",
        ...resourceIdentifiers,
      ]);
      after = clientId;
      clientCount += 1n;
    }
    return queried.value.length < OAUTH_POLICY_PAGE_SIZE
      ? Result.ok(undefined)
      : readNextPage();
  };
  const pagesRead = await readNextPage();
  if (Result.isError(pagesRead)) {
    return Result.err(pagesRead.error);
  }

  return Result.ok({
    clientCount: clientCount.toString(),
    digest: initialized.hasher.digest("hex"),
    resourceCount: initialized.resourceCount.toString(),
    valid,
  } satisfies OAuthPolicyProjection);
};

const readActualOAuthPolicy = async (database: BetterAuthAuditDatabase) => {
  const resourceRows = await queryRows(
    database,
    sql`
      SELECT identifier, name, allowed_scopes AS "allowedScopes"
        FROM oauth_resource
       ORDER BY identifier
    `,
  );
  if (Result.isError(resourceRows)) {
    return resourceRows;
  }
  const resources: BetterAuthExpectedOAuthResource[] = [];
  for (const row of resourceRows.value) {
    const identifier = isRecord(row) ? requiredString(row["identifier"]) : null;
    const name = isRecord(row) ? requiredString(row["name"]) : null;
    const allowedScopes = isRecord(row)
      ? requiredStringArray(row["allowedScopes"])
      : null;
    if (identifier === null || name === null || allowedScopes === null) {
      return Result.err(
        new BetterAuthAuditError({
          code: "database-query-failed",
          message: "Better Auth OAuth resource census returned invalid data",
        }),
      );
    }
    resources.push({ allowedScopes, identifier, name });
  }

  const initialized = initializeOAuthPolicyProjection(resources);
  let after: string | null = null;
  let clientCount = 0n;
  let valid = initialized.valid;
  const readNextPage = async (): Promise<
    Result<void, BetterAuthAuditError>
  > => {
    const statement =
      after === null
        ? sql`
            SELECT client.client_id AS "clientId",
                   client.application_type AS "applicationType",
                   client.client_credentials_scopes AS "clientCredentialsScopes",
                   ARRAY(
                     SELECT link.resource_id
                       FROM oauth_client_resource link
                      WHERE link.client_id = client.client_id
                      ORDER BY link.resource_id
                   ) AS "resourceIdentifiers"
              FROM oauth_client client
             ORDER BY client.client_id
             LIMIT ${OAUTH_POLICY_PAGE_SIZE}
          `
        : sql`
            SELECT client.client_id AS "clientId",
                   client.application_type AS "applicationType",
                   client.client_credentials_scopes AS "clientCredentialsScopes",
                   ARRAY(
                     SELECT link.resource_id
                       FROM oauth_client_resource link
                      WHERE link.client_id = client.client_id
                      ORDER BY link.resource_id
                   ) AS "resourceIdentifiers"
              FROM oauth_client client
             WHERE client.client_id > ${after}
             ORDER BY client.client_id
             LIMIT ${OAUTH_POLICY_PAGE_SIZE}
          `;
    const queried = await queryRows(database, statement);
    if (Result.isError(queried)) {
      return Result.err(queried.error);
    }
    for (const row of queried.value) {
      const clientId = isRecord(row) ? requiredString(row["clientId"]) : null;
      const applicationType = isRecord(row)
        ? requiredString(row["applicationType"])
        : null;
      const clientCredentialsScopes = isRecord(row)
        ? requiredStringArray(row["clientCredentialsScopes"])
        : null;
      const resourceIdentifiers = isRecord(row)
        ? requiredStringArray(row["resourceIdentifiers"])
        : null;
      if (
        clientId === null ||
        applicationType === null ||
        clientCredentialsScopes === null ||
        resourceIdentifiers === null
      ) {
        return Result.err(
          new BetterAuthAuditError({
            code: "database-query-failed",
            message:
              "Better Auth OAuth client policy census returned invalid data",
          }),
        );
      }
      valid &&=
        (applicationType === "native" || applicationType === "web") &&
        sortedUnique(clientCredentialsScopes).length ===
          clientCredentialsScopes.length &&
        sortedUnique(resourceIdentifiers).length === resourceIdentifiers.length;
      updateOAuthPolicyValue(initialized.hasher, [
        "client",
        clientId,
        applicationType,
        ...clientCredentialsScopes.toSorted(),
        "resources",
        ...resourceIdentifiers.toSorted(),
      ]);
      after = clientId;
      clientCount += 1n;
    }
    return queried.value.length < OAUTH_POLICY_PAGE_SIZE
      ? Result.ok(undefined)
      : readNextPage();
  };
  const pagesRead = await readNextPage();
  if (Result.isError(pagesRead)) {
    return Result.err(pagesRead.error);
  }
  return Result.ok({
    clientCount: clientCount.toString(),
    digest: initialized.hasher.digest("hex"),
    resourceCount: initialized.resourceCount.toString(),
    valid,
  } satisfies OAuthPolicyProjection);
};

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

const noForeignKeyOrphansStatement = (
  policies: readonly AuthTableAuditPolicy[],
) => {
  const orphanStatements = policies.flatMap((policy) =>
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
  return sql`
    SELECT NOT (${sql.join(orphanStatements, sql` OR `)}) AS "passed"
  `;
};

const foreignKeysValidatedStatement = (
  policies: readonly AuthTableAuditPolicy[],
) => {
  const expectedForeignKeys = policies.flatMap((policy) =>
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
  return sql`
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
};

const accessBoundariesStatement = (includeFutureTables: boolean) => {
  const policies: readonly AuthAccessPolicy[] = Object.values(
    AUTH_ACCESS_POLICY,
  ).filter(
    ({ tableName }) =>
      includeFutureTables || PRESERVED_AUTH_TABLE_NAMES.includes(tableName),
  );
  const expectedTables = policies.map(
    ({ access, tableName }) => sql`(${tableName}::text, ${access}::text)`,
  );
  const expectedPolicies = policies.flatMap(
    ({ policies: policyRules, tableName }) =>
      policyRules.map(
        ({ command, name, predicate }) =>
          sql`(
          ${tableName}::text,
          ${name}::text,
          ${command}::text,
          ${predicate}::text
        )`,
      ),
  );
  return sql`
    WITH expected_tables(table_name, access) AS (
      VALUES ${sql.join(expectedTables, sql`, `)}
    ),
    expected_policies(table_name, policy_name, command, predicate) AS (
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
              AND policy.permissive = 'PERMISSIVE'
              AND policy.cmd = expected.command
              AND policy.roles = ARRAY['stella']::name[]
              AND CASE expected.predicate
                    WHEN 'deny' THEN
                      policy.qual = 'false' AND policy.with_check = 'false'
                    WHEN 'scoped-read' THEN
                      policy.qual IS NOT NULL
                      AND policy.qual <> 'true'
                      AND policy.with_check IS NULL
                    WHEN 'scoped-write' THEN
                      policy.qual IS NOT NULL
                      AND policy.qual <> 'true'
                      AND policy.with_check = policy.qual
                    ELSE false
                  END
         )
      )
      AND NOT EXISTS (
        SELECT 1
          FROM pg_policies policy
          JOIN expected_tables expected
            ON expected.table_name = policy.tablename
         WHERE policy.schemaname = 'public'
           AND (
             policy.roles @> ARRAY['stella']::name[]
             OR policy.roles @> ARRAY['public']::name[]
           )
           AND NOT EXISTS (
             SELECT 1
               FROM expected_policies expected_policy
              WHERE expected_policy.table_name = policy.tablename
                AND expected_policy.policy_name = policy.policyname
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

const accessPolicyInventoryStatement = sql`
  SELECT jsonb_build_array(
           table_record.relname,
           table_record.relrowsecurity,
           policy.policyname,
           policy.permissive,
           policy.cmd,
           policy.roles::text,
           policy.qual,
           policy.with_check
         )::text AS "fingerprintPart"
    FROM pg_class table_record
    JOIN pg_namespace namespace ON namespace.oid = table_record.relnamespace
    LEFT JOIN pg_policies policy
      ON policy.schemaname = namespace.nspname
     AND policy.tablename = table_record.relname
   WHERE namespace.nspname = 'public'
     AND table_record.relname IN (${sql.join(
       PRESERVED_AUTH_TABLE_NAMES.map((tableName) => sql`${tableName}`),
       sql`, `,
     )})
   ORDER BY table_record.relname, policy.policyname
`;

const readAccessPolicyDigest = async (database: BetterAuthAuditDatabase) => {
  const queried = await queryRows(database, accessPolicyInventoryStatement);
  if (Result.isError(queried)) {
    return queried;
  }
  const hasher = new Bun.CryptoHasher("sha256");
  for (const row of queried.value) {
    const fingerprintPart = isRecord(row)
      ? requiredString(row["fingerprintPart"])
      : null;
    if (fingerprintPart === null) {
      return Result.err(
        new BetterAuthAuditError({
          code: "database-query-failed",
          message: "Better Auth access policy inventory returned invalid data",
        }),
      );
    }
    hasher.update(fingerprintPart);
    hasher.update("\0");
  }
  return Result.ok(hasher.digest("hex"));
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

const nonMicrosoftProjectedIdentityUniqueStatement = sql`
  SELECT NOT EXISTS (
    SELECT 1
      FROM account
     WHERE provider_id <> ${AUTH_PROVIDER_IDS.MICROSOFT}
     GROUP BY
       CASE provider_id
         WHEN ${AUTH_PROVIDER_IDS.CREDENTIAL} THEN ${ACCOUNT_ISSUERS.CREDENTIAL}
         WHEN ${AUTH_PROVIDER_IDS.GOOGLE} THEN ${ACCOUNT_ISSUERS.GOOGLE}
         ELSE 'local:invalid'
       END,
       CASE provider_id
         WHEN ${AUTH_PROVIDER_IDS.CREDENTIAL} THEN user_id
         ELSE account_id
       END
    HAVING count(*) > 1
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
         AND index_record.indpred IS NULL
         AND index_record.indexprs IS NULL
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
  WITH expected_resource_foreign_keys(
    child_column,
    parent_table,
    parent_column
  ) AS (
    VALUES
      ('client_id'::text, 'oauth_client'::text, 'client_id'::text),
      ('resource_id'::text, 'oauth_resource'::text, 'identifier'::text)
  )
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
         AND index_record.indpred IS NULL
         AND index_record.indexprs IS NULL
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
         AND index_record.indpred IS NULL
         AND index_record.indexprs IS NULL
         AND (
           SELECT array_agg(attribute.attname ORDER BY key_position.ordinality)
             FROM unnest(index_record.indkey) WITH ORDINALITY key_position(attnum, ordinality)
             JOIN pg_attribute attribute
               ON attribute.attrelid = table_record.oid
              AND attribute.attnum = key_position.attnum
         ) = ARRAY['identifier']::name[]
    )
    AND NOT EXISTS (
      SELECT 1
        FROM expected_resource_foreign_keys expected
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
            AND child.relname = ${FUTURE_AUTH_TABLES.OAUTH_CLIENT_RESOURCE}
            AND child_attribute.attname = expected.child_column
            AND parent.relname = expected.parent_table
            AND parent_attribute.attname = expected.parent_column
       )
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
    ) = (SELECT count(*) FROM expected_resource_foreign_keys)
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

type ReadTableCensusOptions = {
  preservedColumns: readonly string[];
  tableName: string;
};

const readTableCensus = async (
  database: BetterAuthAuditDatabase,
  { preservedColumns, tableName }: ReadTableCensusOptions,
) => {
  const primaryKeyHasher = new Bun.CryptoHasher("sha256");
  const rowContentHasher = new Bun.CryptoHasher("sha256");
  const preservedValues = preservedColumns.map((column) =>
    tableName === AUTH_TABLE_AUDIT_POLICY.account.tableName &&
    column === "account_id"
      ? sql`CASE
              WHEN provider_id = ${AUTH_PROVIDER_IDS.MICROSOFT}
                THEN ${MICROSOFT_ACCOUNT_ID_CENSUS_SENTINEL}
              ELSE account_id
            END`
      : sql.identifier(column),
  );
  let after: string | null = null;
  let rowCount = 0n;
  const pages = {
    [Symbol.asyncIterator]: () => {
      let complete = false;
      return {
        next: async () => {
          if (complete) {
            return { done: true as const, value: undefined };
          }
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
          complete =
            Result.isError(queried) ||
            queried.value.length < PRIMARY_KEY_PAGE_SIZE;
          return { done: false as const, value: queried };
        },
      };
    },
  };

  for await (const queried of pages) {
    if (Result.isError(queried)) {
      return queried;
    }
    let nextAfter: string | null = after;
    for (const row of queried.value) {
      const primaryKey = isRecord(row)
        ? requiredString(row["primaryKey"])
        : null;
      const rowContent = isRecord(row)
        ? requiredString(row["rowContent"])
        : null;
      // PostgreSQL's primary-key collation owns both ORDER BY and the cursor.
      // JavaScript lexical comparison can disagree for mixed-case text IDs.
      if (
        primaryKey === null ||
        rowContent === null ||
        (nextAfter !== null && primaryKey === nextAfter)
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
      rowCount += 1n;
    }
    after = nextAfter;
  }

  return Result.ok({
    preservedColumns,
    primaryKeyDigest: primaryKeyHasher.digest("hex"),
    rowContentDigest: rowContentHasher.digest("hex"),
    rowCount: rowCount.toString(),
  });
};

const readAuthCensus = async (
  database: BetterAuthAuditDatabase,
  baseline: BetterAuthAuditBaseline | null,
) => {
  const entries: BetterAuthAuditBaseline["tables"] = {};
  const readModel = async (
    index: number,
  ): Promise<
    Result<BetterAuthAuditBaseline["tables"], BetterAuthAuditError>
  > => {
    const model = AUTH_BASELINE_MODEL_NAMES.at(index);
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
    const policy = AUTH_TABLE_AUDIT_POLICY[model];
    const census = await readTableCensus(database, {
      preservedColumns:
        baseline?.tables[model]?.preservedColumns ?? policy.preservedColumns,
      tableName: policy.tableName,
    });
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

const createBaseline = (
  tables: BetterAuthAuditBaseline["tables"],
  accessPolicyDigest: string,
  accountIdentityProjection: BetterAuthAuditBaseline["accountIdentityProjection"],
  oauthPolicyProjection: BetterAuthAuditBaseline["oauthPolicyProjection"],
): BetterAuthAuditBaseline => ({
  accountIdentityProjection,
  accessPolicyDigest,
  formatVersion: 4,
  oauthPolicyProjection,
  tables,
});

const emptyBaseline = (): BetterAuthAuditBaseline =>
  createBaseline(
    Object.fromEntries(
      AUTH_BASELINE_MODEL_NAMES.map((model) => [
        model,
        {
          preservedColumns: AUTH_TABLE_AUDIT_POLICY[model].preservedColumns,
          primaryKeyDigest: "",
          rowContentDigest: "",
          rowCount: "0",
        },
      ]),
    ),
    "0".repeat(64),
    { digest: "0".repeat(64), rowCount: "0" },
    {
      clientCount: "0",
      digest: "0".repeat(64),
      resourceCount: "0",
    },
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
  expectedOAuthResources: readonly BetterAuthExpectedOAuthResource[];
  mode: BetterAuthAuditMode;
  trustedIdentityMap: BetterAuthTrustedIdentityMap | null;
};

export const runBetterAuthMigrationAudit = async ({
  baseline,
  database,
  expectedOAuthResources,
  mode,
  trustedIdentityMap,
}: RunBetterAuthMigrationAuditOptions): Promise<
  Result<AuditRunResult, BetterAuthAuditError>
> => {
  const checks: BetterAuthAuditCheck[] = [];
  const tables = await tableInventory(database);
  if (Result.isError(tables)) {
    return tables;
  }

  const requiredTablePolicies =
    mode === BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION
      ? AUTH_TABLE_POLICIES.filter(({ tableName }) =>
          PRESERVED_AUTH_TABLE_NAMES.includes(tableName),
        )
      : AUTH_TABLE_POLICIES;
  const currentSchemaComplete = requiredTablePolicies.every(({ tableName }) =>
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

  const accessPolicyDigest = await readAccessPolicyDigest(database);
  if (Result.isError(accessPolicyDigest)) {
    return accessPolicyDigest;
  }
  const accessBoundaries = await booleanCheck(
    database,
    BETTER_AUTH_AUDIT_CHECKS.AUTH_ACCESS_BOUNDARIES,
    accessBoundariesStatement(mode !== BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION),
  );
  if (Result.isError(accessBoundaries)) {
    return accessBoundaries;
  }
  checks.push(
    check(
      BETTER_AUTH_AUDIT_CHECKS.AUTH_ACCESS_BOUNDARIES,
      accessBoundaries.value.status === "passed" &&
        (mode === BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION ||
          (baseline !== null &&
            baseline.accessPolicyDigest === accessPolicyDigest.value)),
    ),
  );

  const commonChecks = [
    [
      BETTER_AUTH_AUDIT_CHECKS.AUTH_FOREIGN_KEYS_REACHABLE,
      noForeignKeyOrphansStatement(requiredTablePolicies),
    ],
    [
      BETTER_AUTH_AUDIT_CHECKS.AUTH_FOREIGN_KEYS_VALIDATED,
      foreignKeysValidatedStatement(requiredTablePolicies),
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

  let expectedAccountIdentityProjection: BetterAuthAuditBaseline["accountIdentityProjection"];
  let expectedOAuthPolicyProjection: BetterAuthAuditBaseline["oauthPolicyProjection"];
  if (mode === BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION) {
    if (trustedIdentityMap === null) {
      return Result.err(
        new BetterAuthAuditError({
          code: "invalid-identity-map",
          message:
            "Better Auth trusted identity map is required before migration",
        }),
      );
    }
    const projection = await readProjectedAccountIdentities(
      database,
      trustedIdentityMap,
    );
    if (Result.isError(projection)) {
      return projection;
    }
    const nonMicrosoftUnique = await booleanCheck(
      database,
      BETTER_AUTH_AUDIT_CHECKS.ACCOUNT_IDENTITY_PROJECTED_UNIQUE,
      nonMicrosoftProjectedIdentityUniqueStatement,
    );
    if (Result.isError(nonMicrosoftUnique)) {
      return nonMicrosoftUnique;
    }
    checks.push(
      check(
        BETTER_AUTH_AUDIT_CHECKS.ACCOUNT_IDENTITY_MAPPING_COMPLETE,
        projection.value.mappingComplete,
      ),
      check(
        BETTER_AUTH_AUDIT_CHECKS.ACCOUNT_IDENTITY_PROJECTED_UNIQUE,
        projection.value.mappingComplete &&
          projection.value.collisionFree &&
          nonMicrosoftUnique.value.status === "passed",
      ),
    );
    expectedAccountIdentityProjection = {
      digest: projection.value.digest,
      rowCount: projection.value.rowCount,
    };
    const oauthProjection = await readProjectedOAuthPolicy(
      database,
      expectedOAuthResources,
    );
    if (Result.isError(oauthProjection)) {
      return oauthProjection;
    }
    checks.push(
      check(
        BETTER_AUTH_AUDIT_CHECKS.OAUTH_POLICY_PROJECTED_VALID,
        oauthProjection.value.valid,
      ),
    );
    expectedOAuthPolicyProjection = {
      clientCount: oauthProjection.value.clientCount,
      digest: oauthProjection.value.digest,
      resourceCount: oauthProjection.value.resourceCount,
    };
  } else {
    if (baseline === null) {
      return Result.err(
        new BetterAuthAuditError({
          code: "invalid-baseline",
          message: "Better Auth audit baseline is required after migration",
        }),
      );
    }
    const actualProjection = await readActualAccountIdentities(database);
    if (Result.isError(actualProjection)) {
      return actualProjection;
    }
    expectedAccountIdentityProjection = baseline.accountIdentityProjection;
    checks.push(
      check(
        BETTER_AUTH_AUDIT_CHECKS.ACCOUNT_IDENTITIES_MATCH_TRUSTED_PROJECTION,
        actualProjection.value.digest ===
          baseline.accountIdentityProjection.digest &&
          actualProjection.value.rowCount ===
            baseline.accountIdentityProjection.rowCount,
      ),
    );
    const actualOAuthPolicy = await readActualOAuthPolicy(database);
    if (Result.isError(actualOAuthPolicy)) {
      return actualOAuthPolicy;
    }
    expectedOAuthPolicyProjection = baseline.oauthPolicyProjection;
    checks.push(
      check(
        BETTER_AUTH_AUDIT_CHECKS.OAUTH_POLICY_MATCHES_TRUSTED_PROJECTION,
        actualOAuthPolicy.value.valid &&
          actualOAuthPolicy.value.digest ===
            baseline.oauthPolicyProjection.digest &&
          actualOAuthPolicy.value.clientCount ===
            baseline.oauthPolicyProjection.clientCount &&
          actualOAuthPolicy.value.resourceCount ===
            baseline.oauthPolicyProjection.resourceCount,
      ),
    );
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

  const census = await readAuthCensus(database, baseline);
  if (Result.isError(census)) {
    return census;
  }
  const nextBaseline = createBaseline(
    census.value,
    accessPolicyDigest.value,
    expectedAccountIdentityProjection,
    expectedOAuthPolicyProjection,
  );
  if (mode === BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION) {
    checks.push(check(BETTER_AUTH_AUDIT_CHECKS.AUTH_ROWS_BASELINED, true));
  } else {
    const preserved =
      baseline !== null &&
      AUTH_BASELINE_MODEL_NAMES.every((model) => {
        const expected = baseline.tables[model];
        const actual = census.value[model];
        return (
          expected !== undefined &&
          actual !== undefined &&
          expected.preservedColumns.length === actual.preservedColumns.length &&
          expected.preservedColumns.every(
            (column, index) => actual.preservedColumns.at(index) === column,
          ) &&
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

const digestSchema = v.pipe(v.string(), v.regex(/^[a-f\d]{64}$/u));
const rowCountSchema = v.pipe(v.string(), v.regex(/^\d+$/u));

const tableCensusSchema = (model: AuthModel) => {
  const allowedColumns = new Set<string>(
    AUTH_TABLE_AUDIT_POLICY[model].preservedColumns,
  );
  return v.strictObject({
    preservedColumns: v.pipe(
      v.array(v.string()),
      v.minLength(1),
      v.check(
        (columns) => new Set(columns).size === columns.length,
        "Preserved columns must be unique",
      ),
      v.check(
        (columns) => columns.includes("id"),
        "Preserved columns must include id",
      ),
      v.check(
        (columns) => columns.every((column) => allowedColumns.has(column)),
        "Preserved columns must be reviewed",
      ),
    ),
    primaryKeyDigest: digestSchema,
    rowContentDigest: digestSchema,
    rowCount: rowCountSchema,
  });
};

const betterAuthAuditBaselineSchema: v.GenericSchema<
  unknown,
  BetterAuthAuditBaseline
> = v.strictObject({
  accountIdentityProjection: v.strictObject({
    digest: digestSchema,
    rowCount: rowCountSchema,
  }),
  accessPolicyDigest: digestSchema,
  formatVersion: v.literal(4),
  oauthPolicyProjection: v.strictObject({
    clientCount: rowCountSchema,
    digest: digestSchema,
    resourceCount: rowCountSchema,
  }),
  tables: v.strictObject(
    Object.fromEntries(
      AUTH_BASELINE_MODEL_NAMES.map((model) => [
        model,
        tableCensusSchema(model),
      ]),
    ),
  ),
});

const GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MICROSOFT_ISSUER_PATTERN =
  /^https:\/\/login\.microsoftonline\.com\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/v2\.0$/u;
const nonEmptyStringSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(512),
);
export const MAX_MICROSOFT_IDENTITY_MAPPINGS = 100_000;

const betterAuthTrustedIdentityMapSchema: v.GenericSchema<
  unknown,
  BetterAuthTrustedIdentityMap
> = v.strictObject({
  formatVersion: v.literal(1),
  microsoftAccounts: v.pipe(
    v.array(
      v.strictObject({
        accountId: v.pipe(v.string(), v.regex(GUID_PATTERN)),
        accountRowId: nonEmptyStringSchema,
        issuer: v.pipe(v.string(), v.regex(MICROSOFT_ISSUER_PATTERN)),
        legacyAccountId: nonEmptyStringSchema,
      }),
    ),
    v.maxLength(MAX_MICROSOFT_IDENTITY_MAPPINGS),
    v.check(
      (accounts) =>
        new Set(accounts.map(({ accountRowId }) => accountRowId)).size ===
        accounts.length,
      "Microsoft account row IDs must be unique",
    ),
    v.check(
      (accounts) =>
        new Set(
          accounts.map(({ accountId, issuer }) => `${issuer}\0${accountId}`),
        ).size === accounts.length,
      "Microsoft account identities must be unique",
    ),
  ),
});

export const parseBetterAuthAuditBaseline = (
  value: unknown,
): Result<BetterAuthAuditBaseline, BetterAuthAuditError> => {
  const invalidBaseline = () =>
    Result.err(
      new BetterAuthAuditError({
        code: "invalid-baseline",
        message: "Better Auth audit baseline is invalid",
      }),
    );
  const parsed = v.safeParse(betterAuthAuditBaselineSchema, value);
  return parsed.success ? Result.ok(parsed.output) : invalidBaseline();
};

export const parseBetterAuthTrustedIdentityMap = (
  value: unknown,
): Result<BetterAuthTrustedIdentityMap, BetterAuthAuditError> => {
  const parsed = v.safeParse(betterAuthTrustedIdentityMapSchema, value);
  return parsed.success
    ? Result.ok(parsed.output)
    : Result.err(
        new BetterAuthAuditError({
          code: "invalid-identity-map",
          message: "Better Auth trusted identity map is invalid",
        }),
      );
};

export const renderBetterAuthAuditReport = (
  value: BetterAuthAuditReport,
): string => `${JSON.stringify(value)}\n`;
