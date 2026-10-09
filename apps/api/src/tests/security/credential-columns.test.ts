import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { is } from "drizzle-orm";
import {
  boolean,
  getTableConfig,
  integer,
  jsonb,
  PgTable,
  pgTable,
  text,
} from "drizzle-orm/pg-core";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import { agentDelegation } from "@/api/db/agent-auth-schema";
import { oauthConsent } from "@/api/db/auth-schema";
import { bytea } from "@/api/db/columns";
import { matterInboundAddresses } from "@/api/db/schema";
import { ACCOUNT_DELETION_MANUAL_TABLES } from "@/api/lib/account-deletion-steps";
import { revokeOrganizationMemberAuthArtifacts } from "@/api/lib/auth-artifacts";
import { ORGANIZATION_MEMBER_CLEANUP_COLUMNS } from "@/api/lib/member-assignment-offboarding";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import drizzleConfig from "../../../drizzle.config";
import classificationData from "./credential-column-classifications.json";

const reasonSchema = v.pipe(v.string(), v.trim(), v.minLength(1));
const writeCheckSchema = v.strictObject({
  path: reasonSchema,
  transformPattern: reasonSchema,
  writePattern: reasonSchema,
});
const classificationSchema = v.variant("status", [
  v.strictObject({
    status: v.literal("hashed"),
    reason: reasonSchema,
    writeCheck: writeCheckSchema,
  }),
  v.strictObject({
    status: v.literal("encrypted"),
    keyScope: v.picklist(["application", "organization"]),
    reason: reasonSchema,
    writeCheck: writeCheckSchema,
  }),
  v.strictObject({
    status: v.literal("public_by_design"),
    reason: reasonSchema,
  }),
  v.strictObject({ status: v.literal("cleartext"), reason: reasonSchema }),
]);
const registrySchema = v.record(v.string(), classificationSchema);
type ClassificationRegistry = v.InferOutput<typeof registrySchema>;
const classifications = v.parse(registrySchema, classificationData);

const API_ROOT = path.resolve(import.meta.dir, "../../..");
const REGISTRY_PATH =
  "apps/api/src/tests/security/credential-column-classifications.json";
const REPO_ROOT = path.resolve(API_ROOT, "../..");

const CREDENTIAL_NAME_TERMS = [
  "token",
  "tokens",
  "secret",
  "key",
  "password",
  "otp",
  "credential",
  "credentials",
  "encrypted",
  "verifier",
  "code_hash",
  "backup_codes",
  "authorization_code",
  "user_code",
  "refresh",
  "recovery_codes",
  "passcode",
  "pin_hash",
] as const;
const CREDENTIAL_NAME_PATTERN = new RegExp(
  `(?:^|_)(?:${CREDENTIAL_NAME_TERMS.join("|")})(?:_|\\d|$)`,
  "u",
);
const OPAQUE_CREDENTIAL_COLUMNS = new Set([
  "verification.identifier",
  "verification.value",
  "oauth_refresh_token.rotation_replay_response",
  "mcp_oauth_state.state",
  "sharepoint_oauth_state.state",
  "mcp_oauth_clients.registration_response",
  "business_registry_credentials.ciphertext",
]);

const discoverTables = async () => {
  const schema = drizzleConfig.schema;
  if (schema === undefined) {
    panic("Migration schema configuration is empty");
  }
  const entries = typeof schema === "string" ? [schema] : schema;
  const filenames = new Set<string>();
  for (const entry of entries) {
    const matches = [
      ...new Bun.Glob(entry).scanSync({ cwd: API_ROOT, onlyFiles: true }),
    ];
    if (matches.length === 0) {
      panic(`Migration schema entry matches no modules: ${entry}`);
    }
    for (const filename of matches) {
      filenames.add(path.join(API_ROOT, filename));
    }
  }
  const tables = new Map<string, PgTable>();
  for (const filename of filenames) {
    const module = await import(pathToFileURL(filename).href);
    for (const value of Object.values(module)) {
      if (!is(value, PgTable)) {
        continue;
      }
      const { name } = getTableConfig(value);
      const previous = tables.get(name);
      if (previous !== undefined && previous !== value) {
        panic(`Duplicate table definition: ${name}`);
      }
      tables.set(name, value);
    }
  }
  if (tables.size === 0) {
    panic("Schema table discovery is empty");
  }
  return [...tables.values()];
};

const credentialColumns = (tables: readonly PgTable[]) => {
  const selected = new Set<string>();
  for (const table of tables) {
    const { name, columns } = getTableConfig(table);
    for (const column of columns) {
      const columnKey = `${name}.${column.name}`;
      const normalizedName = column.name
        .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
        .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
        .toLowerCase();
      if (
        CREDENTIAL_NAME_PATTERN.test(normalizedName) ||
        OPAQUE_CREDENTIAL_COLUMNS.has(columnKey)
      ) {
        selected.add(columnKey);
      }
    }
  }
  return selected;
};

type CompareRegistryOptions = {
  tables: readonly PgTable[];
  registry: ClassificationRegistry;
};
const compareRegistry = ({ tables, registry }: CompareRegistryOptions) => {
  const selected = credentialColumns(tables);
  return {
    unclassified: [...selected]
      .filter((column) => registry[column] === undefined)
      .toSorted(),
    stale: Object.keys(registry)
      .filter((column) => !selected.has(column))
      .toSorted(),
  };
};

const INITIAL_CLEARTEXT_COLUMNS = new Set([
  "account.access_token",
  "account.id_token",
  "account.refresh_token",
  "agent_registration.authorization_code",
  "agent_registration.client_secret_sink",
  "agent_registration.user_code",
  "mcp_oauth_state.code_verifier",
  "mcp_oauth_state.state",
  "session.token",
  "sharepoint_oauth_state.code_verifier",
  "sharepoint_oauth_state.state",
  "verification.identifier",
  "verification.value",
]);

const cleartextColumns = (registry: ClassificationRegistry) =>
  Object.entries(registry)
    .filter(([, classification]) => classification.status === "cleartext")
    .map(([column]) => column);

const addedCleartextColumns = (
  current: ClassificationRegistry,
  baseline: ClassificationRegistry | null,
) => {
  const known =
    baseline === null
      ? INITIAL_CLEARTEXT_COLUMNS
      : new Set(cleartextColumns(baseline));
  return cleartextColumns(current)
    .filter((column) => !known.has(column))
    .toSorted();
};

const readBaseRegistry = () => {
  const result = Bun.spawnSync(
    ["git", "show", `origin/main:${REGISTRY_PATH}`],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode === 0) {
    return v.parse(registrySchema, JSON.parse(result.stdout.toString()));
  }
  const error = result.stderr.toString();
  if (/exists on disk, but not in|does not exist in/u.test(error)) {
    return null;
  }
  return panic(`Could not read the classification baseline: ${error}`);
};

const tables = await discoverTables();
const FIXTURE_COLUMN_BUILDERS = {
  text,
  integer,
  boolean,
  jsonb,
  bytea,
} as const;

const organizationCredentialTables = () => {
  const credentialTables = new Set(
    Object.entries(classifications)
      .filter(
        ([, classification]) => classification.status !== "public_by_design",
      )
      .map(([column]) => column.split(".").at(0)),
  );
  const selected = new Set<string>([
    getTableConfig(agentDelegation).name,
    getTableConfig(oauthConsent).name,
  ]);
  for (const table of tables) {
    const { name, columns } = getTableConfig(table);
    if (!credentialTables.has(name)) {
      continue;
    }
    const names = new Set(columns.map((column) => column.name));
    const userScope =
      names.has("user_id") ||
      names.has("bound_user_id") ||
      names.has("created_by") ||
      (name === "apikey" && names.has("reference_id"));
    const organizationScope =
      names.has("organization_id") ||
      names.has("bound_organization_id") ||
      names.has("active_organization_id") ||
      names.has("workspace_id") ||
      (["oauth_access_token", "oauth_refresh_token"].includes(name) &&
        names.has("reference_id")) ||
      (name === "apikey" && names.has("metadata"));
    if (userScope && organizationScope) {
      selected.add(name);
    }
  }
  return [...selected].toSorted();
};

const handledMemberTables = async () => {
  const handled = new Set(
    ORGANIZATION_MEMBER_CLEANUP_COLUMNS.map(([column]) => {
      const table = tables.find((candidate) =>
        getTableConfig(candidate).columns.includes(column),
      );
      if (table === undefined) {
        return panic(`Cleanup column ${column.name} has no schema table`);
      }
      return getTableConfig(table).name;
    }),
  );
  const record = (table: PgTable) => ({
    where: async () => {
      handled.add(getTableConfig(table).name);
    },
  });
  await revokeOrganizationMemberAuthArtifacts(
    {
      delete: record,
      update: (table) => ({ set: () => record(table) }),
    },
    {
      organizationId: mintAuthProviderId<"organization">(),
      userId: mintAuthProviderId<"user">(),
    },
  );
  return handled;
};

const missingCleanupTables = (handled: ReadonlySet<string>) =>
  organizationCredentialTables().filter((name) => !handled.has(name));

describe("stored credential column classifications", () => {
  test("discovers migration schema tables registered through withRLS", () => {
    expect(tables).toContain(matterInboundAddresses);
    expect(
      credentialColumns(tables).has("matter_inbound_addresses.token"),
    ).toBe(true);
  });

  test("classifies every selected schema column and keeps no stale decisions", () => {
    expect(compareRegistry({ tables, registry: classifications })).toEqual({
      unclassified: [],
      stale: [],
    });
    const allColumns = new Set(
      tables.flatMap((table) => {
        const { name, columns } = getTableConfig(table);
        return columns.map((column) => `${name}.${column.name}`);
      }),
    );
    expect(
      [...OPAQUE_CREDENTIAL_COLUMNS].filter(
        (column) => !allColumns.has(column),
      ),
    ).toEqual([]);
  });

  test("cleartext decisions only shrink against the base registry", () => {
    expect(addedCleartextColumns(classifications, readBaseRegistry())).toEqual(
      [],
    );
  });

  test("reviewed write boundaries use their classified transforms", () => {
    const sources = new Map<string, string>();
    for (const classification of Object.values(classifications)) {
      if (
        classification.status !== "hashed" &&
        classification.status !== "encrypted"
      ) {
        continue;
      }
      const {
        path: sourcePath,
        transformPattern,
        writePattern,
      } = classification.writeCheck;
      let source = sources.get(sourcePath);
      if (source === undefined) {
        const paths = [
          ...new Bun.Glob(sourcePath).scanSync({
            cwd: API_ROOT,
            onlyFiles: true,
          }),
        ].toSorted();
        expect(paths.length, sourcePath).toBeGreaterThan(0);
        source = paths
          .map((filename) =>
            readFileSync(path.join(API_ROOT, filename), "utf-8"),
          )
          .join("\n");
        sources.set(sourcePath, source);
      }
      expect(source, sourcePath).toMatch(new RegExp(transformPattern, "u"));
      expect(source, sourcePath).toMatch(new RegExp(writePattern, "u"));
    }
  });

  test("requires decisions for every newly named credential column", () => {
    assertProperty(
      "requires decisions for every newly named credential column",
      fc.property(
        fc.constantFrom(...CREDENTIAL_NAME_TERMS),
        fc.integer({ min: 0, max: 100_000 }),
        fc.constantFrom("snake", "camel", "upper"),
        fc.constantFrom("text", "integer", "boolean", "jsonb", "bytea"),
        (term, suffix, style, columnType) => {
          const capitalized = term
            .split("_")
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join("");
          const names = {
            snake: `fixture_${term}_${suffix}`,
            camel: `fixture${capitalized}${suffix}`,
            upper: `fixture_${term.toUpperCase()}_${suffix}`,
          } as const;
          const column = names[style];
          const table = pgTable("classification_fixture", {
            value: FIXTURE_COLUMN_BUILDERS[columnType](column),
          });
          const columnKey = `classification_fixture.${column}`;
          expect(credentialColumns([table]).has(columnKey)).toBe(true);
          expect(compareRegistry({ tables: [table], registry: {} })).toEqual({
            unclassified: [columnKey],
            stale: [],
          });
          const registry = {
            [columnKey]: {
              status: "hashed",
              reason: "Fixture transformation decision.",
              writeCheck: {
                path: "fixture.ts",
                transformPattern: "hashFixture",
                writePattern: "storedFixture",
              },
            },
          } as const satisfies ClassificationRegistry;
          expect(compareRegistry({ tables: [table], registry })).toEqual({
            unclassified: [],
            stale: [],
          });
          expect(
            addedCleartextColumns(
              {
                [columnKey]: {
                  status: "cleartext",
                  reason: "Fixture storage decision.",
                },
              },
              registry,
            ),
          ).toEqual([columnKey]);
          expect(addedCleartextColumns({}, registry)).toEqual([]);
          expect(compareRegistry({ tables: [], registry })).toEqual({
            unclassified: [],
            stale: [columnKey],
          });
        },
      ),
    );
  });

  test("removed cleartext decisions cannot be replaced by different entries", () => {
    const baseline = {
      "fixture.old_token": { status: "cleartext", reason: "Fixture lookup." },
    } as const satisfies ClassificationRegistry;
    expect(addedCleartextColumns({}, baseline)).toEqual([]);
    expect(
      addedCleartextColumns(
        {
          "fixture.new_token": {
            status: "cleartext",
            reason: "Fixture lookup.",
          },
        },
        baseline,
      ),
    ).toEqual(["fixture.new_token"]);
    expect(
      addedCleartextColumns(
        {
          "fixture.old_token": {
            status: "encrypted",
            keyScope: "application",
            reason: "Fixture envelope.",
            writeCheck: {
              path: "fixture.ts",
              transformPattern: "encryptFixture",
              writePattern: "storedFixture",
            },
          },
        },
        baseline,
      ),
    ).toEqual([]);
  });

  test("the initial cleartext boundary also rejects additional decisions", () => {
    expect(addedCleartextColumns(classifications, null)).toEqual([]);
    expect(
      addedCleartextColumns(
        {
          ...classifications,
          "fixture.new_token": {
            status: "cleartext",
            reason: "Fixture lookup.",
          },
        },
        null,
      ),
    ).toEqual(["fixture.new_token"]);
  });

  test("member removal handles every organization credential table", async () => {
    expect(missingCleanupTables(await handledMemberTables())).toEqual([]);
  });

  test("every cleanup table remains required when a disposition is removed", async () => {
    const dispositions = [
      await handledMemberTables(),
      new Set(
        ACCOUNT_DELETION_MANUAL_TABLES.map(
          (table) => getTableConfig(table).name,
        ),
      ),
    ];
    for (const handled of dispositions) {
      for (const name of organizationCredentialTables()) {
        expect(handled.has(name), name).toBe(true);
        const reduced = new Set(handled);
        reduced.delete(name);
        expect(missingCleanupTables(reduced)).toContain(name);
      }
    }
  });

  test("account deletion declares every organization credential table", () => {
    const handled = new Set(
      ACCOUNT_DELETION_MANUAL_TABLES.map((table) => getTableConfig(table).name),
    );
    expect(missingCleanupTables(handled)).toEqual([]);
  });
});
