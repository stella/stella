import { panic } from "better-result";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  fingerprintEvolutionFailures,
  OWNED_IDENTITY_PROTOCOL_SLICES,
  OWNED_IDENTITY_PROTOCOL_SOURCE_PATHS,
  ownedProtocolSourcePin,
  scanExternalIdentity,
} from "./source-fingerprint-baseline";

const actualProtocolSources = () =>
  OWNED_IDENTITY_PROTOCOL_SOURCE_PATHS.map((file) => ({
    path: file,
    source: readFileSync(path.resolve(import.meta.dir, "..", file), "utf-8"),
  }));

test("reviewed alternative identities are revoked by changes to their actual owner contracts", () => {
  const sources = actualProtocolSources();
  const receiptSite =
    "apps/api/src/handlers/contacts/import-contacts.ts::external-id-write::writeImportRows/toContactValues";
  const createSite =
    "apps/api/src/handlers/contacts/create.ts::external-id-write::insertContactRow";
  const versionSite =
    "apps/api/src/lib/uploads/import-origin.ts::external-id-write::importDocumentSource";
  const original = scanExternalIdentity(sources).map(({ key }) => key);
  for (const site of [receiptSite, createSite, versionSite]) {
    expect(original).not.toContain(site);
  }
  for (const mutation of [
    {
      file: "apps/api/src/handlers/contacts/import-contacts.ts",
      from: "existingRequest.requestFingerprint !== requestFingerprint",
      to: "existingRequest.requestFingerprint === requestFingerprint",
      site: receiptSite,
    },
    {
      file: "apps/api/src/handlers/contacts/import-contacts.ts",
      from: "      requestFingerprint,\n      result,",
      to: "      result,",
      site: receiptSite,
    },
    {
      file: "apps/api/src/handlers/contacts/contact-import-receipt.ts",
      from: "return left > right ? 1 : 0;",
      to: "return 0;",
      site: receiptSite,
    },
    {
      file: "apps/api/src/handlers/contacts/import-contacts.ts",
      from: "@/api/handlers/contacts/contact-import-receipt",
      to: "@/api/handlers/contacts/other-receipt",
      site: receiptSite,
    },
    {
      file: "apps/api/src/db/schema/contacts.ts",
      from: '"contact_import_requests",',
      to: '"other_contact_import_requests",',
      site: receiptSite,
    },
    {
      file: "apps/api/src/db/schema/common.ts",
      from: 'import * as p from "drizzle-orm/pg-core";',
      to: 'import * as p from "other-column-owner";',
      site: receiptSite,
    },
    {
      file: "apps/api/src/db/columns.ts",
      from: `sql\`\${JSON.stringify(value)}::text::jsonb\``,
      to: "sql`NULL`",
      site: receiptSite,
    },
    {
      file: "apps/api/src/handlers/contacts/create.ts",
      from: "    .returning();",
      to: "    .onConflictDoUpdate({ target: contacts.id, set: { displayName: body.displayName } }).returning();",
      site: createSite,
    },
    {
      file: "apps/api/src/lib/uploads/entity-create.ts",
      from: "          sha256Hex: declaredSha256Hex,",
      to: "",
      site: versionSite,
    },
    {
      file: "apps/api/src/handlers/uploads/create.ts",
      from: "          declaredSha256: purposeBody.sha256Hex,",
      to: "",
      site: versionSite,
    },
    {
      file: "apps/api/src/handlers/uploads/update.ts",
      from: "    declaredSha256Hex: storedSha256Hex,",
      to: "",
      site: versionSite,
    },
  ]) {
    const owner = sources.find(({ path: file }) => file === mutation.file);
    expect(owner?.source.includes(mutation.from), mutation.file).toBe(true);
    const mutated = sources.map((file) =>
      file.path === mutation.file
        ? {
            ...file,
            source: file.source.replace(mutation.from, () => mutation.to),
          }
        : file,
    );
    expect(
      scanExternalIdentity(mutated).map(({ key }) => key),
      mutation.file,
    ).toContain(mutation.site);
  }
});

test("protocol pins ignore formatting, unrelated schema policies and package metadata", () => {
  const sources = actualProtocolSources();
  for (const change of [
    {
      file: "apps/api/src/handlers/contacts/import-contacts.ts",
      transform: (source: string) =>
        `// Protocol comment\n${source.replace("export const importContactRows", "export   const   importContactRows")}`,
    },
    {
      file: "apps/api/src/db/schema/contacts.ts",
      transform: (source: string) =>
        source.replace(
          '"workspace_select"',
          '"workspace_select_policy_renamed"',
        ),
    },
    {
      file: "apps/api/src/db/schema/contacts.ts",
      transform: (source: string) =>
        `${source}\nconst unrelatedPolicyMetadata = "new owner policy";\n`,
    },
    {
      file: "apps/api/src/db/schema/contacts.ts",
      transform: (source: string) =>
        source.replace(
          '...importProvenanceConstraints("contacts", table),',
          '...importProvenanceConstraints("contacts", table), p.pgPolicy("contacts_select", { for: "select", using: sql`true` }),',
        ),
    },
    {
      file: "packages/sha256/package.json",
      transform: (source: string) =>
        source.replace("{", '{"version":"999.0.0",'),
    },
    {
      file: "apps/api/src/db/schema.ts",
      transform: (source: string) =>
        `${source}\nexport * from "./schema/unrelated";\n`,
    },
  ]) {
    const file = sources.find(
      ({ path: sourcePath }) => sourcePath === change.file,
    );
    const slice = OWNED_IDENTITY_PROTOCOL_SLICES[change.file];
    if (file === undefined || slice === undefined) {
      panic(`Missing owned fixture: ${change.file}`);
    }
    const changed = change.transform(file.source);
    expect(changed, change.file).not.toBe(file.source);
    expect(
      ownedProtocolSourcePin({ ...file, source: changed, slice }),
      change.file,
    ).toBe(ownedProtocolSourcePin({ ...file, slice }));
  }
});

test("semantic pins retain template whitespace and regular-expression identity", () => {
  const file = "apps/api/src/lib/example/protocol.ts";
  const slice = { declarations: ["protocol"] };
  const source = `const protocol = (value) => sql\`SELECT \${value} FROM rows WHERE kind ~ /^a b$/u\`;`;
  const original = ownedProtocolSourcePin({ path: file, source, slice });
  for (const changed of [
    source.replace(" FROM", "FROM"),
    source.replace("a b", "a  b"),
  ]) {
    expect(
      ownedProtocolSourcePin({ path: file, source: changed, slice }),
    ).not.toBe(original);
  }
});

test("semantic pins retain regular-expression literal bytes", () => {
  const file = "apps/api/src/lib/example/protocol.ts";
  const slice = { declarations: ["protocol"] };
  const source = "const protocol = (value) => /^a b$/u.test(value);";
  expect(
    ownedProtocolSourcePin({
      path: file,
      source: source.replace("a b", "a  b"),
      slice,
    }),
  ).not.toBe(ownedProtocolSourcePin({ path: file, source, slice }));
});

test("provenance formatting credit cannot escape its reviewed immutable-upload consumer", () => {
  const sources = actualProtocolSources();
  const site =
    "apps/api/src/lib/uploads/import-origin.ts::external-id-write::importDocumentSource";
  const escaped = `export const mutate = (tx, origin) => tx.update(entityVersions).set({ source: importDocumentSource(origin) });`;
  for (const source of [
    `import { importDocumentSource } from "@/api/lib/uploads/import-origin"; ${escaped}`,
    `import { importDocumentSource } from "@/api/lib/uploads/../uploads/import-origin"; ${escaped}`,
    "export const load = () => import(`@/api/lib/uploads/import-origin`);",
    `import { importDocumentSource as format } from "@/api/lib/uploads/import-origin"; export const mutate = (tx, origin) => tx.update(entityVersions).set({ source: format(origin) });`,
    `import * as origin from "@/api/lib/uploads/import-origin"; export const mutate = (tx, value) => tx.update(entityVersions).set({ source: origin.importDocumentSource(value) });`,
    `export { importDocumentSource } from "@/api/lib/uploads/import-origin";`,
    `export { createRequire } from "node:module";`,
    `export * from "module";`,
    `export const mutate = async (tx, origin) => { const formatter = await import("@/api/lib/uploads/import-origin"); return tx.update(entityVersions).set({ source: formatter.importDocumentSource(origin) }); };`,
    `export const load = (moduleName) => import(moduleName);`,
    `const load = require; const { importDocumentSource } = load("@/api/lib/uploads/import-origin"); ${escaped}`,
    `import { createRequire } from "node:module"; const load = createRequire(import.meta.url); const { importDocumentSource } = load("@/api/lib/uploads/import-origin"); ${escaped}`,
    `const { createRequire } = require("node:module"); const load = createRequire(import.meta.url); const { importDocumentSource } = load("@/api/lib/uploads/import-origin"); ${escaped}`,
  ]) {
    expect(
      scanExternalIdentity([
        ...sources,
        { path: "apps/api/src/lib/new-consumer.ts", source },
      ]).map(({ key }) => key),
    ).toContain(site);
  }
  for (const appended of [
    escaped,
    `import { importDocumentSource as format } from "@/api/lib/uploads/import-origin"; export const mutate = (tx, origin) => tx.update(entityVersions).set({ source: format(origin) });`,
  ]) {
    const changed = sources.map((file) =>
      file.path === "apps/api/src/handlers/uploads/create.ts"
        ? { ...file, source: `${file.source}\n${appended}` }
        : file,
    );
    expect(scanExternalIdentity(changed).map(({ key }) => key)).toContain(site);
  }
});

test("a private import writer cannot escape its receipt transaction", () => {
  const sources = actualProtocolSources();
  const changed = sources.map((file) =>
    file.path === "apps/api/src/handlers/contacts/import-contacts.ts"
      ? {
          ...file,
          source: `${file.source}\nexport const writeWithoutReceipt = (options) => writeImportRows(options);\n`,
        }
      : file,
  );
  expect(scanExternalIdentity(changed).map(({ key }) => key)).toContain(
    "apps/api/src/handlers/contacts/import-contacts.ts::external-id-write::writeImportRows/toContactValues",
  );
});

test("new and shadowed writers never inherit an owned-protocol credit", () => {
  const file = "apps/api/src/handlers/contacts/import-contacts.ts";
  const mutated = actualProtocolSources().map((source) =>
    source.path === file
      ? {
          ...source,
          source: `${source.source}\nexport const newWriter = (item) => ({ externalSource: item.source, externalId: item.id });\nexport const shadowedWriter = (importContactRows) => ({ externalSource: importContactRows.source, externalId: importContactRows.id });\n`,
        }
      : source,
  );
  const findings = scanExternalIdentity(mutated).map(({ key }) => key);
  expect(findings).toContain(`${file}::external-id-write::newWriter`);
  expect(findings).toContain(`${file}::external-id-write::shadowedWriter`);
});

test("known schema constructors and boolean selections do not credit parsed values or unknown calls", () => {
  const file = "apps/api/src/lib/example/identity.ts";
  const source = `
    import * as p from "drizzle-orm/pg-core";
    import * as v from "valibot";
    const columns = () => ({ externalSource: p.varchar("external_source"), externalId: p.varchar("external_id") });
    const schema = v.strictObject({ externalSource: v.string(), externalId: v.nullable(v.string()) });
    const selected = { externalSource: true, externalId: true };
    const returning = db.insert(rows).values(input).returning({ externalSource: rows.externalSource, externalId: rows.externalId });
    const read = fake.select({ externalSource: rows.externalSource, externalId: rows.externalId });
    const parsedWrite = db.insert(rows).values({ externalSource: v.parse(v.string(), item.source), externalId: v.parse(v.string(), item.id) });
    const safeParsedWrite = db.insert(rows).values({ externalSource: v.safeParse(v.string(), item.source), externalId: v.safeParse(v.string(), item.id) });
    const unmarked = (item) => ({ externalSource: item.source, externalId: item.id });
    const marked = (item) => ({ externalSource: item.source, externalId: item.id, externalChangeKey: item.etag });
    const itemDedupeKey = (item) => item.externalId;
  `;
  expect(
    scanExternalIdentity([{ path: file, source }]).map(({ key }) => key),
  ).toEqual([
    `${file}::external-id-dedupe-key::itemDedupeKey`,
    `${file}::external-id-write::parsedWrite`,
    `${file}::external-id-write::read`,
    `${file}::external-id-write::returning`,
    `${file}::external-id-write::safeParsedWrite`,
    `${file}::external-id-write::unmarked`,
  ]);
});

test("schema namespace shadows remain unproved across binding forms", () => {
  const file = "apps/api/src/lib/example/shadow.ts";
  for (const body of [
    "const shadowed = (v) => ({ externalSource: v.string(), externalId: v.string() });",
    "const shadowed = ({v}) => ({ externalSource: v.string(), externalId: v.string() });",
    "const shadowed = () => { const v = localFactory; return { externalSource: v.string(), externalId: v.string() }; };",
    "const shadowed = () => { try { action(); } catch (v) { return { externalSource: v.string(), externalId: v.string() }; } };",
    "const shadowed = () => { for (const v of factories) { return { externalSource: v.string(), externalId: v.string() }; } };",
    "const shadowed = () => { function v() {} return { externalSource: v.string(), externalId: v.string() }; };",
  ]) {
    const findings = scanExternalIdentity([
      { path: file, source: `import * as v from "valibot"; ${body}` },
    ]);
    expect(findings.map(({ key }) => key)).toEqual([
      `${file}::external-id-write::shadowed`,
    ]);
  }
});

const fingerprint = (
  value: string,
  storedInputIdentity: string,
  version: number,
) => ({
  fingerprint: value,
  storedInputIdentity,
  version,
});

test("the source fingerprint baseline and evolution guard match the tree", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "scripts/source-fingerprint-baseline.ts",
      "--check",
      "--base",
      "origin/main",
    ],
    {
      cwd: path.resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(
    result.exitCode,
    `${result.stdout.toString()}${result.stderr.toString()}`,
  ).toBe(0);
}, 120_000);

test("accepts a fingerprint change over changed stored bytes without a version bump", () => {
  expect(
    fingerprintEvolutionFailures(
      { "cz-ns::decision": fingerprint("new", "new-input", 0) },
      { "cz-ns::decision": fingerprint("old", "old-input", 0) },
    ),
  ).toEqual([]);
});

test("rejects an allowlisted adapter hash change over unchanged stored bytes without a version bump", () => {
  expect(
    fingerprintEvolutionFailures(
      { "pl-courts::search": fingerprint("new", "same-input", 0) },
      { "pl-courts::search": fingerprint("old", "same-input", 0) },
    ),
  ).toEqual([
    "pl-courts::search: fixture fingerprint changed without a version bump",
  ]);
});

test("accepts an allowlisted adapter hash change over unchanged stored bytes with a version bump", () => {
  expect(
    fingerprintEvolutionFailures(
      { "pl-courts::search": fingerprint("new", "same-input", 1) },
      { "pl-courts::search": fingerprint("old", "same-input", 0) },
    ),
  ).toEqual([]);
});

test("rejects a fingerprint version decrease", () => {
  expect(
    fingerprintEvolutionFailures(
      { "cz-ns::decision": fingerprint("same", "same-input", 0) },
      { "cz-ns::decision": fingerprint("same", "same-input", 1) },
    ),
  ).toEqual(["cz-ns::decision: fingerprint version decreased"]);
});
