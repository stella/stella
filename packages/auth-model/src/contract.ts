/** Better Auth version whose logical schema this contract describes. */
export const BETTER_AUTH_CONTRACT_VERSION = "1.7.1";

export const ORGANIZATION_ROLE_NAMES = [
  "owner",
  "admin",
  "member",
  "intern",
  "external",
] as const;

export type OrganizationRoleName = (typeof ORGANIZATION_ROLE_NAMES)[number];

/** Better Auth organization resources. Hosts extend this with product grants. */
export const BETTER_AUTH_ORGANIZATION_STATEMENTS = {
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  team: ["create", "update", "delete"],
  ac: ["create", "read", "update", "delete"],
} as const;

type OrganizationPermissionMap = {
  [Resource in keyof typeof BETTER_AUTH_ORGANIZATION_STATEMENTS]: (typeof BETTER_AUTH_ORGANIZATION_STATEMENTS)[Resource][number][];
};

export type BetterAuthOrganizationRoleGrants = Record<
  OrganizationRoleName,
  OrganizationPermissionMap
>;

/** Core grants shared by every application; product grants remain host-owned. */
export const BETTER_AUTH_ORGANIZATION_ROLE_GRANTS = {
  owner: {
    organization: ["update", "delete"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
    team: ["create", "update", "delete"],
    ac: ["create", "read", "update", "delete"],
  },
  admin: {
    organization: ["update"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
    team: ["create", "update", "delete"],
    ac: ["create", "read", "update", "delete"],
  },
  member: {
    organization: [],
    member: [],
    invitation: [],
    team: [],
    ac: ["read"],
  },
  intern: {
    organization: [],
    member: [],
    invitation: [],
    team: [],
    ac: [],
  },
  external: {
    organization: [],
    member: [],
    invitation: [],
    team: [],
    ac: [],
  },
} satisfies BetterAuthOrganizationRoleGrants;

/**
 * Values that change Better Auth's organization authorization semantics.
 * Hooks, adapters, email delivery, and product-specific options stay local.
 */
export const BETTER_AUTH_ORGANIZATION_OPTIONS = {
  allowUserToCreateOrganization: true,
  cancelPendingInvitationsOnReInvite: false,
  creatorRole: "owner",
  invitationExpiresIn: 60 * 60 * 48,
  membershipLimit: 500,
} as const;

/** Adapter switches which must match in every host. */
export const BETTER_AUTH_ADAPTER_OPTIONS = {
  camelCase: false,
  provider: "pg",
  transaction: true,
  usePlural: false,
} as const;

export const BETTER_AUTH_CORE_MODEL_NAMES = [
  "user",
  "session",
  "account",
  "verification",
  "organization",
  "member",
  "invitation",
] as const;

export type BetterAuthCoreModelName =
  (typeof BETTER_AUTH_CORE_MODEL_NAMES)[number];

export type BetterAuthFieldType = "boolean" | "date" | "string";

export type BetterAuthFieldDefault =
  | { kind: "none" }
  | { kind: "runtime" }
  | { kind: "literal"; value: boolean | number | string };

export type BetterAuthFieldReference = {
  field: "id";
  model: "organization" | "user";
  onDelete: "cascade" | null;
};

export type BetterAuthLogicalFieldContract = {
  default: BetterAuthFieldDefault;
  indexed: boolean;
  input: "allowed" | "server-managed";
  onUpdate: boolean;
  reference: BetterAuthFieldReference | null;
  required: boolean;
  returned: boolean;
  sortable: boolean;
  type: BetterAuthFieldType;
  unique: boolean;
};

export type BetterAuthDatabaseFieldContract = {
  columnName: string;
  columnType: "boolean" | "text" | "timestamptz";
  default: BetterAuthFieldDefault;
  notNull: boolean;
  onUpdate: boolean;
  precision: number | null;
  reference: BetterAuthFieldReference | null;
  storage: "timestamp-with-time-zone" | null;
  unique: boolean;
};

/** Better Auth behavior and physical database guarantees, kept separate. */
export type BetterAuthFieldContract = {
  database: BetterAuthDatabaseFieldContract;
  logical: BetterAuthLogicalFieldContract;
};

export type BetterAuthIndexContract = {
  fields: readonly string[];
  predicate: string | null;
  unique: boolean;
};

export type BetterAuthModelContract = {
  fields: Record<string, BetterAuthFieldContract>;
  indexes: readonly BetterAuthIndexContract[];
  primaryKey: readonly string[];
  tableName: string;
};

const noDefault = { kind: "none" } as const;
const runtimeDefault = { kind: "runtime" } as const;

type FieldOptions = {
  database?: Partial<
    Omit<
      BetterAuthDatabaseFieldContract,
      "columnName" | "columnType" | "precision" | "storage"
    >
  >;
  default?: BetterAuthFieldDefault;
  indexed?: boolean;
  input?: BetterAuthLogicalFieldContract["input"];
  onUpdate?: boolean;
  reference?: BetterAuthFieldReference;
  required?: boolean;
  returned?: boolean;
  sortable?: boolean;
  unique?: boolean;
};

type BetterAuthFieldDraft = {
  database: Omit<
    BetterAuthDatabaseFieldContract,
    "columnName" | "columnType" | "precision"
  >;
  logical: BetterAuthLogicalFieldContract;
};

const field = (
  type: BetterAuthFieldType,
  options: FieldOptions = {},
): BetterAuthFieldDraft => ({
  database: {
    default: options.database?.default ?? noDefault,
    notNull: options.database?.notNull ?? options.required ?? false,
    onUpdate: options.database?.onUpdate ?? false,
    reference:
      options.database?.reference ??
      (options.reference?.onDelete === "cascade" ? options.reference : null),
    storage: type === "date" ? "timestamp-with-time-zone" : null,
    unique: options.database?.unique ?? options.unique ?? false,
  },
  logical: {
    default: options.default ?? noDefault,
    indexed: options.indexed ?? false,
    input: options.input ?? "allowed",
    onUpdate: options.onUpdate ?? false,
    reference: options.reference ?? null,
    required: options.required ?? false,
    returned: options.returned ?? true,
    sortable: options.sortable ?? false,
    type,
    unique: options.unique ?? false,
  },
});

const toSnakeCase = (value: string): string =>
  value.replaceAll(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);

const databaseColumnType = (
  type: BetterAuthFieldType,
): BetterAuthDatabaseFieldContract["columnType"] => {
  if (type === "date") {
    return "timestamptz";
  }
  if (type === "boolean") {
    return "boolean";
  }
  return "text";
};

const withPhysicalNames = (
  drafts: Record<string, BetterAuthFieldDraft>,
): Record<string, BetterAuthFieldContract> => {
  const result: Record<string, BetterAuthFieldContract> = {};
  for (const [name, draft] of Object.entries(drafts)) {
    const type = draft.logical.type;
    result[name] = {
      ...draft,
      database: {
        ...draft.database,
        columnName: toSnakeCase(name),
        columnType: databaseColumnType(type),
        precision: null,
      },
    };
  }
  return result;
};

const idField = field("string", {
  default: runtimeDefault,
  input: "server-managed",
  required: true,
});
const runtimeDate = field("date", {
  default: runtimeDefault,
  required: true,
  database: { default: runtimeDefault },
});
const runtimeUpdatedDate = field("date", {
  default: runtimeDefault,
  onUpdate: true,
  required: true,
  database: { default: runtimeDefault, onUpdate: true },
});
const updatedDate = field("date", {
  onUpdate: true,
  required: true,
  database: { onUpdate: true },
});
const userReference = {
  field: "id",
  model: "user",
  onDelete: "cascade",
} as const;
const organizationReference = {
  field: "id",
  model: "organization",
  onDelete: null,
} as const;
const organizationDatabaseReference = {
  ...organizationReference,
  onDelete: "cascade",
} as const;
const userPluginReference = { ...userReference, onDelete: null } as const;

/**
 * Normalized Better Auth core plus the organization plugin's shared models and
 * `activeOrganizationId` session extension.
 */
export const BETTER_AUTH_CORE_SCHEMA = {
  user: {
    tableName: "user",
    primaryKey: ["id"],
    fields: withPhysicalNames({
      id: idField,
      name: field("string", { required: true, sortable: true }),
      email: field("string", {
        required: true,
        sortable: true,
        unique: true,
      }),
      emailVerified: field("boolean", {
        default: { kind: "literal", value: false },
        input: "server-managed",
        required: true,
        database: { default: { kind: "literal", value: false } },
      }),
      image: field("string"),
      createdAt: runtimeDate,
      updatedAt: runtimeUpdatedDate,
    }),
    indexes: [],
  },
  session: {
    tableName: "session",
    primaryKey: ["id"],
    fields: withPhysicalNames({
      id: idField,
      expiresAt: field("date", { required: true }),
      token: field("string", { required: true, unique: true }),
      createdAt: runtimeDate,
      updatedAt: updatedDate,
      ipAddress: field("string"),
      userAgent: field("string"),
      userId: field("string", {
        indexed: true,
        reference: userReference,
        required: true,
      }),
      activeOrganizationId: field("string", { input: "server-managed" }),
    }),
    indexes: [
      {
        fields: ["userId", "activeOrganizationId"],
        predicate: null,
        unique: false,
      },
    ],
  },
  account: {
    tableName: "account",
    primaryKey: ["id"],
    fields: withPhysicalNames({
      id: idField,
      issuer: field("string", { required: true }),
      accountId: field("string", { required: true }),
      providerId: field("string", { required: true }),
      userId: field("string", {
        indexed: true,
        reference: userReference,
        required: true,
      }),
      accessToken: field("string", { returned: false }),
      refreshToken: field("string", { returned: false }),
      idToken: field("string", { returned: false }),
      accessTokenExpiresAt: field("date", { returned: false }),
      refreshTokenExpiresAt: field("date", { returned: false }),
      scope: field("string"),
      password: field("string", { returned: false }),
      createdAt: runtimeDate,
      updatedAt: updatedDate,
    }),
    indexes: [
      { fields: ["issuer", "accountId"], predicate: null, unique: true },
      { fields: ["userId"], predicate: null, unique: false },
    ],
  },
  verification: {
    tableName: "verification",
    primaryKey: ["id"],
    fields: withPhysicalNames({
      id: idField,
      identifier: field("string", { indexed: true, required: true }),
      value: field("string", { required: true }),
      expiresAt: field("date", { required: true }),
      createdAt: runtimeDate,
      updatedAt: runtimeUpdatedDate,
    }),
    indexes: [{ fields: ["identifier"], predicate: null, unique: false }],
  },
  organization: {
    tableName: "organization",
    primaryKey: ["id"],
    fields: withPhysicalNames({
      id: idField,
      name: field("string", { required: true, sortable: true }),
      slug: field("string", {
        indexed: true,
        required: true,
        sortable: true,
        unique: true,
      }),
      logo: field("string"),
      createdAt: field("date", { required: true }),
      metadata: field("string"),
    }),
    indexes: [{ fields: ["slug"], predicate: null, unique: true }],
  },
  member: {
    tableName: "member",
    primaryKey: ["id"],
    fields: withPhysicalNames({
      id: idField,
      organizationId: field("string", {
        database: { reference: organizationDatabaseReference },
        indexed: true,
        reference: organizationReference,
        required: true,
      }),
      userId: field("string", {
        database: { reference: userReference },
        indexed: true,
        reference: userPluginReference,
        required: true,
      }),
      role: field("string", {
        default: { kind: "literal", value: "member" },
        required: true,
        sortable: true,
        database: { default: { kind: "literal", value: "member" } },
      }),
      createdAt: field("date", { required: true }),
    }),
    indexes: [
      { fields: ["organizationId"], predicate: null, unique: false },
      { fields: ["userId"], predicate: null, unique: false },
      {
        fields: ["organizationId", "userId"],
        predicate: null,
        unique: true,
      },
    ],
  },
  invitation: {
    tableName: "invitation",
    primaryKey: ["id"],
    fields: withPhysicalNames({
      id: idField,
      organizationId: field("string", {
        database: { reference: organizationDatabaseReference },
        indexed: true,
        reference: organizationReference,
        required: true,
      }),
      email: field("string", {
        indexed: true,
        required: true,
        sortable: true,
      }),
      role: field("string", { sortable: true }),
      status: field("string", {
        default: { kind: "literal", value: "pending" },
        required: true,
        sortable: true,
        database: { default: { kind: "literal", value: "pending" } },
      }),
      expiresAt: field("date", { required: true }),
      createdAt: runtimeDate,
      inviterId: field("string", {
        database: { reference: userReference },
        reference: userPluginReference,
        required: true,
      }),
    }),
    indexes: [
      { fields: ["organizationId"], predicate: null, unique: false },
      { fields: ["email"], predicate: null, unique: false },
    ],
  },
} as const satisfies Record<BetterAuthCoreModelName, BetterAuthModelContract>;

export type BetterAuthAdapterContract = {
  camelCase: boolean;
  dateStorage: "timestamp-with-time-zone";
  idGeneration: "application-string";
  modelNames: Record<BetterAuthCoreModelName, string>;
  provider: "pg";
  sessionStorage: "database";
  transaction: boolean;
  usePlural: boolean;
  verificationStorage: "database";
};

export const BETTER_AUTH_ADAPTER_INVARIANTS = {
  ...BETTER_AUTH_ADAPTER_OPTIONS,
  dateStorage: "timestamp-with-time-zone",
  idGeneration: "application-string",
  sessionStorage: "database",
  verificationStorage: "database",
  modelNames: {
    user: "user",
    session: "session",
    account: "account",
    verification: "verification",
    organization: "organization",
    member: "member",
    invitation: "invitation",
  },
} as const satisfies BetterAuthAdapterContract;

export type BetterAuthSchemaCandidate = {
  adapter: BetterAuthAdapterContract;
  models: Record<string, BetterAuthModelContract>;
};

export type BetterAuthSchemaExtensions = {
  fields?: Partial<
    Record<BetterAuthCoreModelName, Record<string, BetterAuthFieldContract>>
  >;
  indexes?: Partial<
    Record<BetterAuthCoreModelName, readonly BetterAuthIndexContract[]>
  >;
  models?: readonly string[];
};

export type BetterAuthSchemaParityIssue = {
  actual: unknown;
  expected: unknown;
  path: string;
};

export type BetterAuthSchemaParityResult =
  | { status: "compatible" }
  | { issues: BetterAuthSchemaParityIssue[]; status: "incompatible" };

const compareCodeUnits = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
};

const canonical = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

const sortIndexes = (
  indexes: readonly BetterAuthIndexContract[],
): readonly BetterAuthIndexContract[] =>
  indexes.toSorted((left, right) =>
    compareCodeUnits(canonical(left), canonical(right)),
  );

const compare = (
  issues: BetterAuthSchemaParityIssue[],
  path: string,
  actual: unknown,
  expected: unknown,
): void => {
  if (canonical(actual) === canonical(expected)) {
    return;
  }
  issues.push({ actual, expected, path });
};

/**
 * Compares a normalized host schema with the complete shared core. Extensions
 * are exact allowlists: missing, stale, and undeclared additions all fail.
 */
export const compareBetterAuthSchema = (
  candidate: BetterAuthSchemaCandidate,
  extensions: BetterAuthSchemaExtensions = {},
): BetterAuthSchemaParityResult => {
  const issues: BetterAuthSchemaParityIssue[] = [];
  compare(issues, "adapter", candidate.adapter, BETTER_AUTH_ADAPTER_INVARIANTS);

  const coreModelNames = new Set<string>(BETTER_AUTH_CORE_MODEL_NAMES);
  for (const model of extensions.models ?? []) {
    if (coreModelNames.has(model)) {
      issues.push({
        actual: "core model",
        expected: "new extension model",
        path: `extensions.models.${model}`,
      });
    }
  }
  const expectedModelNames = [
    ...BETTER_AUTH_CORE_MODEL_NAMES,
    ...(extensions.models ?? []),
  ].toSorted();
  compare(
    issues,
    "models",
    Object.keys(candidate.models).toSorted(),
    expectedModelNames,
  );

  for (const model of BETTER_AUTH_CORE_MODEL_NAMES) {
    const actual = candidate.models[model];
    const core = BETTER_AUTH_CORE_SCHEMA[model];
    if (!actual) {
      issues.push({
        actual: undefined,
        expected: "core model",
        path: model,
      });
      continue;
    }
    compare(issues, `${model}.tableName`, actual.tableName, core.tableName);
    compare(issues, `${model}.primaryKey`, actual.primaryKey, core.primaryKey);
    const extensionFields = extensions.fields?.[model] ?? {};
    for (const fieldName of Object.keys(extensionFields)) {
      if (fieldName in core.fields) {
        issues.push({
          actual: "core field",
          expected: "new extension field",
          path: `extensions.${model}.${fieldName}`,
        });
      }
    }
    compare(issues, `${model}.fields`, actual.fields, {
      ...extensionFields,
      ...core.fields,
    });
    compare(
      issues,
      `${model}.indexes`,
      sortIndexes(actual.indexes),
      sortIndexes([...core.indexes, ...(extensions.indexes?.[model] ?? [])]),
    );
  }

  if (issues.length === 0) {
    return { status: "compatible" };
  }
  return { issues, status: "incompatible" };
};

export const BETTER_AUTH_PARITY_MANIFEST = {
  adapterInvariants: BETTER_AUTH_ADAPTER_INVARIANTS,
  betterAuthVersion: BETTER_AUTH_CONTRACT_VERSION,
  options: BETTER_AUTH_ORGANIZATION_OPTIONS,
  roleGrants: BETTER_AUTH_ORGANIZATION_ROLE_GRANTS,
  roleNames: ORGANIZATION_ROLE_NAMES,
  schema: BETTER_AUTH_CORE_SCHEMA,
} as const;
