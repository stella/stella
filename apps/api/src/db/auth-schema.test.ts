import { oauthProvider as betterAuthOAuthProvider } from "@better-auth/oauth-provider";
import { twoFactor as betterAuthTwoFactor } from "better-auth/plugins";
import { describe, expect, test } from "bun:test";
import { getColumns } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import type { AnyPgTable } from "drizzle-orm/pg-core";

import {
  BETTER_AUTH_CORE_SCHEMA,
  compareBetterAuthSchema,
} from "@stll/auth-model";
import type {
  BetterAuthFieldContract,
  BetterAuthFieldReference,
  BetterAuthFieldType,
  BetterAuthIndexContract,
  BetterAuthModelContract,
} from "@stll/auth-model";

import {
  AUTH_USER_STELLA_SELECT_COLUMN_NAMES,
  AUTH_USER_STELLA_SELECT_COLUMNS,
  account,
  authSchema,
  invitation,
  jwks,
  member,
  organization,
  session,
  twoFactor,
  user,
  verification,
} from "@/api/db/auth-schema";
import {
  AUTH_DATABASE_ADAPTER_OPTIONS,
  AUTH_DATABASE_ID_OPTIONS,
  AUTH_SESSION_STORAGE_OPTIONS,
  AUTH_VERIFICATION_STORAGE_OPTIONS,
} from "@/api/lib/auth-adapter-options";
import { AUTH_USER_ADDITIONAL_FIELDS } from "@/api/lib/auth-user-additional-fields";

const PRODUCT_AUTH_MODEL_NAMES = [
  "twoFactor",
  "jwks",
  "apikey",
  "oauthClient",
  "oauthClientAssertion",
  "oauthClientResource",
  "oauthAccessToken",
  "oauthRefreshToken",
  "oauthResource",
  "oauthConsent",
] as const;

const OAUTH_PROVIDER_MODEL_TABLES = [
  ["oauthClient", authSchema.oauthClient, ["public", "type"]],
  ["oauthResource", authSchema.oauthResource, []],
  ["oauthClientResource", authSchema.oauthClientResource, []],
  ["oauthRefreshToken", authSchema.oauthRefreshToken, []],
  ["oauthAccessToken", authSchema.oauthAccessToken, []],
  ["oauthConsent", authSchema.oauthConsent, []],
  ["oauthClientAssertion", authSchema.oauthClientAssertion, []],
] as const;

const CORE_AUTH_MODEL_NAMES: readonly string[] = Object.keys(
  BETTER_AUTH_CORE_SCHEMA,
);

const normalizeDateStorage = (
  storage: BetterAuthFieldContract["database"]["storage"] | undefined,
): "timestamp-with-time-zone" => {
  if (storage !== "timestamp-with-time-zone") {
    throw new Error(`Unsupported auth date storage: ${String(storage)}`);
  }
  return storage;
};

const normalizeIdGeneration = (
  databaseOptions: Readonly<Record<string, unknown>>,
): "application-string" => {
  if ("generateId" in databaseOptions) {
    throw new Error("Auth IDs must use Better Auth's string generator");
  }
  return "application-string";
};

const normalizeDatabaseStorage = (
  enabled: boolean,
  name: string,
): "database" => {
  if (!enabled) {
    throw new Error(`${name} must use database storage`);
  }
  return "database";
};

const databaseColumnType = (
  type: BetterAuthFieldType,
): BetterAuthFieldContract["database"]["columnType"] => {
  if (type === "date") {
    return "timestamptz";
  }
  if (type === "boolean") {
    return "boolean";
  }
  return "text";
};

type HostFieldOptions = {
  databaseDefault?: BetterAuthFieldContract["database"]["default"];
  databaseNotNull?: boolean;
  default?: BetterAuthFieldContract["logical"]["default"];
  input?: BetterAuthFieldContract["logical"]["input"];
  required?: boolean;
  returned?: boolean;
};

type HostFieldDatabaseOptions = Pick<
  HostFieldOptions,
  "databaseDefault" | "databaseNotNull"
>;

const hostField = (
  name: string,
  type: BetterAuthFieldType,
  {
    databaseDefault = { kind: "none" },
    databaseNotNull = false,
    default: fieldDefault = { kind: "none" },
    input = "allowed",
    required = false,
    returned = true,
  }: HostFieldOptions = {},
): BetterAuthFieldContract => ({
  database: {
    columnName: name.replaceAll(
      /[A-Z]/gu,
      (letter) => `_${letter.toLowerCase()}`,
    ),
    columnType: databaseColumnType(type),
    default: databaseDefault,
    notNull: databaseNotNull,
    onUpdate: false,
    precision: null,
    reference: null,
    storage: type === "date" ? "timestamp-with-time-zone" : null,
    unique: false,
  },
  logical: {
    default: fieldDefault,
    indexed: false,
    input,
    onUpdate: false,
    reference: null,
    required,
    returned,
    sortable: false,
    type,
    unique: false,
  },
});

const normalizeColumnType = (
  columnType: string,
): BetterAuthFieldContract["database"]["columnType"] => {
  if (columnType === "PgBoolean") {
    return "boolean";
  }
  if (columnType === "PgTimestamp") {
    return "timestamptz";
  }
  if (columnType === "PgText") {
    return "text";
  }
  throw new Error(`Unsupported core auth column type: ${columnType}`);
};

const normalizeDefault = (
  value: unknown,
): BetterAuthFieldContract["database"]["default"] => {
  if (value === undefined) {
    return { kind: "none" };
  }
  if (
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return { kind: "literal", value };
  }
  return { kind: "runtime" };
};

type RuntimeFieldConfig = {
  defaultValue?: unknown;
  index?: boolean;
  input?: boolean;
  onUpdate?: unknown;
  references?: unknown;
  required?: boolean;
  returned?: boolean;
  sortable?: boolean;
  type: string;
  unique?: boolean;
};

const normalizeRuntimeFieldType = (type: string): BetterAuthFieldType => {
  if (type === "boolean" || type === "date" || type === "string") {
    return type;
  }
  throw new Error(`Unsupported host auth field type: ${type}`);
};

const normalizeRuntimeFields = (
  fields: Readonly<Record<string, RuntimeFieldConfig>>,
  databaseOptions: Record<string, HostFieldDatabaseOptions> = {},
): Record<string, BetterAuthFieldContract> => {
  const result: Record<string, BetterAuthFieldContract> = {};
  for (const [name, config] of Object.entries(fields)) {
    if (config.references !== undefined) {
      throw new Error(`Unsupported host auth field reference: ${name}`);
    }
    const contract = hostField(
      name,
      normalizeRuntimeFieldType(config.type),
      databaseOptions[name],
    );
    result[name] = {
      ...contract,
      logical: {
        default: normalizeDefault(config.defaultValue),
        indexed: config.index ?? false,
        input: config.input === false ? "server-managed" : "allowed",
        onUpdate: config.onUpdate !== undefined,
        reference: null,
        required: config.required ?? false,
        returned: config.returned !== false,
        sortable: config.sortable ?? false,
        type: normalizeRuntimeFieldType(config.type),
        unique: config.unique ?? false,
      },
    };
  }
  return result;
};

const TWO_FACTOR_ENABLED_FIELD = betterAuthTwoFactor({
  issuer: "Stella",
}).schema.user.fields.twoFactorEnabled;

const HOST_USER_FIELDS = {
  ...normalizeRuntimeFields(
    {
      ...AUTH_USER_ADDITIONAL_FIELDS,
      twoFactorEnabled: TWO_FACTOR_ENABLED_FIELD,
    },
    {
      timezoneId: {
        databaseDefault: { kind: "literal", value: "UTC" },
        databaseNotNull: true,
      },
      twoFactorEnabled: {
        databaseDefault: { kind: "literal", value: false },
        databaseNotNull: true,
      },
    },
  ),
  deletedAt: hostField("deletedAt", "date", {
    input: "server-managed",
    returned: false,
  }),
};

const HOST_MEMBER_FIELDS = {
  lastActiveWorkspaceId: hostField("lastActiveWorkspaceId", "string", {
    input: "server-managed",
    returned: false,
  }),
} as const;

const referenceTo = (tableName: string): BetterAuthFieldReference => {
  if (tableName === "organization" || tableName === "user") {
    return { field: "id", model: tableName, onDelete: "cascade" };
  }
  throw new Error(`Unsupported core auth reference: ${tableName}`);
};

type NormalizeModelOptions = {
  expectedFields: Record<string, BetterAuthFieldContract>;
  modelName: string;
  table: AnyPgTable;
};

const normalizeModel = ({
  expectedFields,
  modelName,
  table,
}: NormalizeModelOptions) => {
  const columns = getColumns(table);
  const config = getTableConfig(table);
  const logicalNameByColumn = new Map(
    Object.entries(columns).map(([logicalName, column]) => [
      column.name,
      logicalName,
    ]),
  );
  const referencesByColumn = new Map<string, BetterAuthFieldReference>();
  for (const foreignKey of config.foreignKeys) {
    const reference = foreignKey.reference();
    if (
      reference.columns.length !== 1 ||
      reference.foreignColumns.length !== 1
    ) {
      throw new Error(`Composite auth foreign key on ${modelName}`);
    }
    const sourceColumn = reference.columns.at(0);
    const targetColumn = reference.foreignColumns.at(0);
    if (!sourceColumn || !targetColumn || targetColumn.name !== "id") {
      throw new Error(`Unexpected auth foreign key shape on ${modelName}`);
    }
    if (foreignKey.onDelete !== "cascade") {
      throw new Error(`Non-cascading auth foreign key on ${modelName}`);
    }
    referencesByColumn.set(
      sourceColumn.name,
      referenceTo(getTableConfig(reference.foreignTable).name),
    );
  }

  const fields: Record<string, BetterAuthFieldContract> = {};
  for (const [logicalName, column] of Object.entries(columns)) {
    const expected = expectedFields[logicalName];
    if (!expected) {
      throw new Error(`Undeclared auth field ${modelName}.${logicalName}`);
    }
    const columnType = normalizeColumnType(column.columnType);
    const storage =
      columnType === "timestamptz" &&
      "withTimezone" in column &&
      column.withTimezone
        ? "timestamp-with-time-zone"
        : null;
    fields[logicalName] = {
      database: {
        columnName: column.name,
        columnType,
        default: normalizeDefault(column.default),
        notNull: column.notNull,
        onUpdate: column.onUpdateFn !== undefined,
        precision:
          "precision" in column && typeof column.precision === "number"
            ? column.precision
            : null,
        reference: referencesByColumn.get(column.name) ?? null,
        storage,
        unique: column.isUnique,
      },
      logical: expected.logical,
    };
  }

  const dialect = new PgDialect();
  const indexes: BetterAuthIndexContract[] = config.indexes.map((index) => ({
    fields: index.config.columns.map((column) => {
      if (!("name" in column)) {
        throw new Error(`Expression index in core auth model ${modelName}`);
      }
      const logicalName = logicalNameByColumn.get(column.name);
      if (!logicalName) {
        throw new Error(
          `Unknown indexed column ${column.name} on ${modelName}`,
        );
      }
      return logicalName;
    }),
    predicate: index.config.where
      ? dialect.sqlToQuery(index.config.where).sql
      : null,
    unique: index.config.unique,
  }));

  return {
    fields,
    indexes,
    primaryKey: Object.entries(columns)
      .filter(([, column]) => column.primary)
      .map(([logicalName]) => logicalName),
    tableName: config.name,
  } satisfies BetterAuthModelContract;
};

const PRODUCT_MODEL_PLACEHOLDER = {
  fields: {},
  indexes: [],
  primaryKey: ["id"],
  tableName: "extension",
} satisfies BetterAuthModelContract;

describe("auth schema", () => {
  test("covers every Better Auth 1.7 OAuth-provider model and field", () => {
    const dependencySchema = betterAuthOAuthProvider({
      consentPage: "/oauth-ui/consent",
      loginPage: "/oauth-ui/auth",
    }).schema;

    expect(Object.keys(dependencySchema).toSorted()).toEqual(
      OAUTH_PROVIDER_MODEL_TABLES.map(([model]) => model).toSorted(),
    );
    for (const [model, table, rollbackColumns] of OAUTH_PROVIDER_MODEL_TABLES) {
      const dependencyFields = Object.keys(dependencySchema[model].fields);
      const hostFields = Object.keys(getColumns(table)).filter(
        (field) =>
          !rollbackColumns.some((rollbackColumn) => rollbackColumn === field),
      );
      expect(hostFields.toSorted(), model).toEqual(
        ["id", ...dependencyFields].toSorted(),
      );
    }
  });

  test("normalized Better Auth core matches the shared contract", () => {
    expect(
      Object.keys(authSchema)
        .filter((modelName) => !CORE_AUTH_MODEL_NAMES.includes(modelName))
        .toSorted(),
    ).toEqual(PRODUCT_AUTH_MODEL_NAMES.toSorted());

    const models: Record<string, BetterAuthModelContract> = {
      user: normalizeModel({
        expectedFields: {
          ...BETTER_AUTH_CORE_SCHEMA.user.fields,
          ...HOST_USER_FIELDS,
        },
        modelName: "user",
        table: user,
      }),
      session: normalizeModel({
        expectedFields: BETTER_AUTH_CORE_SCHEMA.session.fields,
        modelName: "session",
        table: session,
      }),
      account: normalizeModel({
        expectedFields: BETTER_AUTH_CORE_SCHEMA.account.fields,
        modelName: "account",
        table: account,
      }),
      verification: normalizeModel({
        expectedFields: BETTER_AUTH_CORE_SCHEMA.verification.fields,
        modelName: "verification",
        table: verification,
      }),
      organization: normalizeModel({
        expectedFields: BETTER_AUTH_CORE_SCHEMA.organization.fields,
        modelName: "organization",
        table: organization,
      }),
      member: normalizeModel({
        expectedFields: {
          ...BETTER_AUTH_CORE_SCHEMA.member.fields,
          ...HOST_MEMBER_FIELDS,
        },
        modelName: "member",
        table: member,
      }),
      invitation: normalizeModel({
        expectedFields: BETTER_AUTH_CORE_SCHEMA.invitation.fields,
        modelName: "invitation",
        table: invitation,
      }),
    };
    for (const modelName of PRODUCT_AUTH_MODEL_NAMES) {
      models[modelName] = PRODUCT_MODEL_PLACEHOLDER;
    }

    expect(AUTH_DATABASE_ADAPTER_OPTIONS.schema).toBe(authSchema);

    const result = compareBetterAuthSchema(
      {
        adapter: {
          camelCase: AUTH_DATABASE_ADAPTER_OPTIONS.camelCase,
          dateStorage: normalizeDateStorage(
            models["user"]?.fields["createdAt"]?.database.storage,
          ),
          idGeneration: normalizeIdGeneration(AUTH_DATABASE_ID_OPTIONS),
          modelNames: {
            user: getTableConfig(user).name,
            session: getTableConfig(session).name,
            account: getTableConfig(account).name,
            verification: getTableConfig(verification).name,
            organization: getTableConfig(organization).name,
            member: getTableConfig(member).name,
            invitation: getTableConfig(invitation).name,
          },
          provider: AUTH_DATABASE_ADAPTER_OPTIONS.provider,
          sessionStorage: normalizeDatabaseStorage(
            AUTH_SESSION_STORAGE_OPTIONS.storeSessionInDatabase,
            "Session",
          ),
          transaction: AUTH_DATABASE_ADAPTER_OPTIONS.transaction,
          usePlural: AUTH_DATABASE_ADAPTER_OPTIONS.usePlural,
          verificationStorage: normalizeDatabaseStorage(
            AUTH_VERIFICATION_STORAGE_OPTIONS.storeInDatabase,
            "Verification",
          ),
        },
        models,
      },
      {
        fields: {
          user: HOST_USER_FIELDS,
          member: HOST_MEMBER_FIELDS,
        },
        indexes: {
          account: [
            {
              fields: ["providerId"],
              predicate: `"account"."provider_id" = 'credential'`,
              unique: true,
            },
          ],
          user: [
            {
              fields: ["createdAt", "id"],
              predicate: null,
              unique: false,
            },
          ],
          member: [
            {
              fields: ["lastActiveWorkspaceId"],
              predicate: null,
              unique: false,
            },
          ],
        },
        models: PRODUCT_AUTH_MODEL_NAMES,
      },
    );

    expect(result).toEqual({ status: "compatible" });
  });

  test("jwks includes the columns Better Auth's jwt plugin writes", () => {
    expect(Object.keys(getColumns(jwks)).toSorted()).toEqual([
      "alg",
      "createdAt",
      "crv",
      "expiresAt",
      "id",
      "privateKey",
      "publicKey",
    ]);
  });

  // Locks the table in sync with node_modules/better-auth/dist/plugins/
  // two-factor/schema.mjs: 1.6.23 writes `failedVerificationCount` and
  // `lockedUntil` in its verification path (account lockout is on by default).
  test("twoFactor includes the columns Better Auth's two-factor plugin writes", () => {
    expect(Object.keys(getColumns(twoFactor)).toSorted()).toEqual([
      "backupCodes",
      "failedVerificationCount",
      "id",
      "lockedUntil",
      "secret",
      "userId",
      "verified",
    ]);
  });

  test("stella user grants account for every Better Auth user column", () => {
    const schemaColumnNamesByField: Record<string, string> = Object.fromEntries(
      Object.entries(getColumns(user)).map(([field, column]) => [
        field,
        column.name,
      ]),
    );
    const expectedColumnNames: string[] = [
      ...AUTH_USER_STELLA_SELECT_COLUMN_NAMES,
    ].toSorted();

    expect(schemaColumnNamesByField).toEqual(AUTH_USER_STELLA_SELECT_COLUMNS);
    expect(Object.values(schemaColumnNamesByField).toSorted()).toEqual(
      expectedColumnNames,
    );
  });
});

describe("two_factor user_id uniqueness (enable-race guard)", () => {
  // Better Auth's `/two-factor/enable` deletes-then-inserts a row per user
  // non-atomically, so two enable requests racing can both insert. A UNIQUE
  // index on user_id is the structural guard that serializes enrollment: the
  // losing insert fails instead of leaving duplicate secrets. Assert the
  // schema declares that uniqueness (the migration mirrors it).
  test("user_id carries a unique index, not a plain one", () => {
    const userIdIndexes = getTableConfig(twoFactor).indexes.filter((index) =>
      index.config.columns.some(
        (column) => "name" in column && column.name === "user_id",
      ),
    );

    expect(userIdIndexes).toHaveLength(1);
    expect(userIdIndexes[0]?.config.unique).toBe(true);
  });
});
