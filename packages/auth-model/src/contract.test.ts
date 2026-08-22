import { getAuthTables } from "better-auth/db";
import { organization } from "better-auth/plugins";
import { describe, expect, test } from "bun:test";

import {
  BETTER_AUTH_ADAPTER_INVARIANTS,
  BETTER_AUTH_CONTRACT_VERSION,
  BETTER_AUTH_CORE_MODEL_NAMES,
  BETTER_AUTH_CORE_SCHEMA,
  BETTER_AUTH_ORGANIZATION_OPTIONS,
  compareBetterAuthSchema,
} from "./contract";
import type {
  BetterAuthFieldDefault,
  BetterAuthFieldContract,
  BetterAuthFieldReference,
  BetterAuthFieldType,
  BetterAuthModelContract,
} from "./contract";

const exactModels: Record<string, BetterAuthModelContract> = Object.fromEntries(
  BETTER_AUTH_CORE_MODEL_NAMES.map((model) => [
    model,
    BETTER_AUTH_CORE_SCHEMA[model],
  ]),
);

const exactCandidate = {
  adapter: BETTER_AUTH_ADAPTER_INVARIANTS,
  models: exactModels,
};

const optionalString = {
  database: {
    columnName: "last_active_project_id",
    columnType: "text",
    default: { kind: "none" },
    notNull: false,
    onUpdate: false,
    precision: null,
    reference: null,
    storage: null,
    unique: false,
  },
  logical: {
    default: { kind: "none" },
    indexed: false,
    input: "allowed",
    onUpdate: false,
    reference: null,
    required: false,
    returned: true,
    sortable: false,
    type: "string",
    unique: false,
  },
} satisfies BetterAuthFieldContract;

const normalizeDependencyDefault = (value: unknown): BetterAuthFieldDefault => {
  if (value === undefined) {
    return { kind: "none" };
  }
  if (typeof value === "function") {
    return { kind: "runtime" };
  }
  if (
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return { kind: "literal", value };
  }
  throw new Error("Unsupported Better Auth logical default");
};

const normalizeDependencyType = (value: unknown): BetterAuthFieldType => {
  if (value === "boolean" || value === "date" || value === "string") {
    return value;
  }
  throw new Error(`Unsupported Better Auth core field type: ${String(value)}`);
};

const normalizeReferenceModel = (
  value: string | undefined,
): BetterAuthFieldReference["model"] | null => {
  if (value === undefined) {
    return null;
  }
  if (value === "organization" || value === "user") {
    return value;
  }
  throw new Error(`Unsupported Better Auth core reference model: ${value}`);
};

const normalizeReferenceField = (
  value: string | undefined,
): BetterAuthFieldReference["field"] | null => {
  if (value === undefined) {
    return null;
  }
  if (value === "id") {
    return value;
  }
  throw new Error(`Unsupported Better Auth core reference field: ${value}`);
};

const normalizeReferenceDelete = (
  value: string | undefined,
): BetterAuthFieldReference["onDelete"] => {
  if (value === undefined) {
    return null;
  }
  if (value === "cascade") {
    return value;
  }
  throw new Error(`Unsupported Better Auth core reference action: ${value}`);
};

describe("Better Auth core contract", () => {
  test("pins the dependency version that defines the schema", async () => {
    const rootPackage: unknown = await Bun.file(
      new URL("../../../package.json", import.meta.url),
    ).json();

    expect(rootPackage).toHaveProperty(
      "catalog.better-auth",
      BETTER_AUTH_CONTRACT_VERSION,
    );
    expect(organization(BETTER_AUTH_ORGANIZATION_OPTIONS).version).toBe(
      BETTER_AUTH_CONTRACT_VERSION,
    );
  });

  test("covers every core and organization-plugin logical field", () => {
    const tables = getAuthTables({
      plugins: [organization(BETTER_AUTH_ORGANIZATION_OPTIONS)],
    });

    for (const model of BETTER_AUTH_CORE_MODEL_NAMES) {
      const dependencyFields = Object.keys(
        tables[model]?.fields ?? {},
      ).toSorted();
      const contractFields = Object.keys(BETTER_AUTH_CORE_SCHEMA[model].fields)
        .filter((field) => field !== "id")
        .toSorted();
      expect(dependencyFields).toEqual(contractFields);
    }
  });

  test("tracks every Better Auth logical field semantic", () => {
    const tables = getAuthTables({
      plugins: [organization(BETTER_AUTH_ORGANIZATION_OPTIONS)],
    });

    for (const model of BETTER_AUTH_CORE_MODEL_NAMES) {
      const dependencyFields = tables[model]?.fields ?? {};
      const contractModel: BetterAuthModelContract =
        BETTER_AUTH_CORE_SCHEMA[model];
      for (const [fieldName, dependency] of Object.entries(dependencyFields)) {
        const contract = contractModel.fields[fieldName];
        expect(
          contract,
          `${model}.${fieldName} missing from contract`,
        ).toBeDefined();
        if (!contract) {
          throw new Error(`${model}.${fieldName} missing from contract`);
        }
        expect(contract.logical.type).toBe(
          normalizeDependencyType(dependency.type),
        );
        expect(contract.logical.required).toBe(dependency.required ?? false);
        expect(contract.logical.default).toEqual(
          normalizeDependencyDefault(dependency.defaultValue),
        );
        expect(contract.logical.unique).toBe(dependency.unique ?? false);
        expect(contract.logical.input).toBe(
          dependency.input === false ? "server-managed" : "allowed",
        );
        expect(contract.logical.returned).toBe(dependency.returned !== false);
        expect(contract.logical.sortable).toBe(dependency.sortable ?? false);
        expect(contract.logical.indexed).toBe(dependency.index ?? false);
        expect(contract.logical.onUpdate).toBe(
          dependency.onUpdate !== undefined,
        );
        expect(contract.logical.reference?.model ?? null).toBe(
          normalizeReferenceModel(dependency.references?.model),
        );
        expect(contract.logical.reference?.field ?? null).toBe(
          normalizeReferenceField(dependency.references?.field),
        );
        expect(contract.logical.reference?.onDelete ?? null).toBe(
          normalizeReferenceDelete(dependency.references?.onDelete),
        );
      }
    }
  });
});

describe("schema parity", () => {
  test("accepts the exact normalized core", () => {
    expect(compareBetterAuthSchema(exactCandidate)).toEqual({
      status: "compatible",
    });
  });

  test("canonicalizes record and index order", () => {
    const reorderedUserFields = Object.fromEntries(
      Object.entries(BETTER_AUTH_CORE_SCHEMA.user.fields).toReversed(),
    );
    const models = {
      ...exactModels,
      user: {
        ...BETTER_AUTH_CORE_SCHEMA.user,
        fields: reorderedUserFields,
      },
      member: {
        ...BETTER_AUTH_CORE_SCHEMA.member,
        indexes: BETTER_AUTH_CORE_SCHEMA.member.indexes.toReversed(),
      },
    };

    expect(
      compareBetterAuthSchema({
        adapter: BETTER_AUTH_ADAPTER_INVARIANTS,
        models,
      }),
    ).toEqual({ status: "compatible" });
  });

  test("requires exact field and model extension allowlists", () => {
    const models = {
      ...exactModels,
      member: {
        ...BETTER_AUTH_CORE_SCHEMA.member,
        fields: {
          ...BETTER_AUTH_CORE_SCHEMA.member.fields,
          lastActiveProjectId: optionalString,
        },
      },
      jwks: {
        fields: {},
        indexes: [],
        primaryKey: ["id"],
        tableName: "jwks",
      },
    };

    expect(
      compareBetterAuthSchema(
        { adapter: BETTER_AUTH_ADAPTER_INVARIANTS, models },
        {
          fields: { member: { lastActiveProjectId: optionalString } },
          models: ["jwks"],
        },
      ),
    ).toEqual({ status: "compatible" });
    expect(
      compareBetterAuthSchema({
        adapter: BETTER_AUTH_ADAPTER_INVARIANTS,
        models,
      }).status,
    ).toBe("incompatible");

    expect(
      compareBetterAuthSchema(exactCandidate, {
        fields: { member: { staleField: optionalString } },
      }).status,
    ).toBe("incompatible");

    expect(
      compareBetterAuthSchema({
        adapter: {
          ...BETTER_AUTH_ADAPTER_INVARIANTS,
          transaction: false,
        },
        models: exactModels,
      }).status,
    ).toBe("incompatible");
  });

  test("does not allow an extension to redefine a core field", () => {
    const result = compareBetterAuthSchema(exactCandidate, {
      fields: { member: { role: optionalString } },
      models: ["user"],
    });

    expect(result.status).toBe("incompatible");
    if (result.status === "incompatible") {
      expect(
        result.issues.some(({ path }) => path === "extensions.member.role"),
      ).toBe(true);
      expect(
        result.issues.some(({ path }) => path === "extensions.models.user"),
      ).toBe(true);
    }
  });

  test("reports a missing core model directly", () => {
    const models: Record<string, BetterAuthModelContract> = Object.fromEntries(
      BETTER_AUTH_CORE_MODEL_NAMES.filter(
        (model) => model !== "invitation",
      ).map((model) => [model, BETTER_AUTH_CORE_SCHEMA[model]]),
    );

    const result = compareBetterAuthSchema({
      adapter: BETTER_AUTH_ADAPTER_INVARIANTS,
      models,
    });
    expect(result.status).toBe("incompatible");
    if (result.status === "incompatible") {
      expect(result.issues.some(({ path }) => path === "invitation")).toBe(
        true,
      );
    }
  });
});
