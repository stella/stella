// Enumerate the members of the source-fingerprint guard and hold them to a
// shrink-only, reasoned baseline (scripts/source-fingerprint-baseline.json).
//
// Three sections, each an exact set keyed without line numbers:
//
//   drivers  `<registration>::<driver>`: a registered case-law source whose
//            enrolled fixture builds a decision whose `rawHash` is not
//            `sourceFingerprint` over what it stores. Measured by
//            apps/api/src/handlers/case-law/ingestion/adapters/source-fingerprint-guard.test.ts,
//            which fails on a new or a stale member.
//   files    an adapter file the `raw-hash-from-source-fingerprint` rule
//            exempts: it still writes `rawHash` without the owner. Measured
//            here by running the rule in census mode.
//   writers  `<file>::<kind>::<name>`: a write of a row keyed by an external
//            id (`externalSource` + `externalId`) without the change marker or
//            an exact reviewed owned-protocol proof,
//            or a dedupe key built from an external id without one. Measured
//            here by a TypeScript AST scan, together with the schema check
//            that every table with an `external_id` column declares a change
//            marker. Async source observations require comparable change
//            identity; synchronous request receipts, insert-only creation and
//            immutable versions may use their real durable identity, proven
//            below rather than adding placeholder fields or debt entries.
//
// Modes:
//   bun scripts/source-fingerprint-baseline.ts --check [--base <ref>]
//   bun scripts/source-fingerprint-baseline.ts --write
//   bun scripts/source-fingerprint-baseline.ts --self-test
//
// `--write` regenerates every section from the tree, keeps the reasons of
// surviving rows, and fills a generated reason for a new one; the membership
// check then refuses any row the base does not already have.

import { panic } from "better-result";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript6";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";
import { sha256Hex } from "@stll/sha256/bun";

import { BASELINE_PATHS } from "./baseline-paths.ts";
import { addedEntries, runLedgerMembershipGuard } from "./ledger-membership.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const BASELINE = BASELINE_PATHS.sourceFingerprint;
const RULE = "raw-hash-from-source-fingerprint";
const ADAPTERS_DIR = "apps/api/src/handlers/case-law/ingestion/adapters";
const API_SOURCE_DIR = "apps/api/src";
const SCHEMA_DIR = "apps/api/src/db/schema";
const GUARD_TEST =
  "src/handlers/case-law/ingestion/adapters/source-fingerprint-guard.test.ts";
const CENSUS_OUT_ENV = "SOURCE_FINGERPRINT_CENSUS_OUT";

const REASONED = v.record(v.string(), v.pipe(v.string(), v.nonEmpty()));
const BASELINE_SCHEMA = v.object({
  comment: v.string(),
  drivers: REASONED,
  fingerprints: v.optional(
    v.record(
      v.string(),
      v.object({
        fingerprint: v.string(),
        storedInputIdentity: v.optional(v.string(), ""),
        version: v.number(),
      }),
    ),
    {},
  ),
  files: REASONED,
  writers: REASONED,
});
type Baseline = v.InferOutput<typeof BASELINE_SCHEMA>;
const SECTIONS = ["drivers", "files", "writers"] as const;
type Section = (typeof SECTIONS)[number];

const DRIVER_ROWS = v.array(
  v.object({ key: v.string(), reason: v.pipe(v.string(), v.nonEmpty()) }),
);
const DRIVER_CENSUS = v.object({
  fingerprints: v.array(
    v.object({
      key: v.string(),
      fingerprint: v.string(),
      storedInputIdentity: v.string(),
      version: v.number(),
    }),
  ),
  misses: DRIVER_ROWS,
});

const LINT_OUTPUT = v.object({
  diagnostics: v.array(v.object({ code: v.string(), filename: v.string() })),
});

const FILE_REASON =
  "Writes rawHash without sourceFingerprint; migrate each site to the owner, then drop this row.";

/** Names the change marker a row keyed by an external id must carry. */
const CHANGE_MARKERS = new Set([
  "externalChangeKey",
  "contentHash",
  "sourceFingerprint",
  "rawHash",
]);
const CHANGE_MARKER_COLUMNS = new Set([
  "external_change_key",
  "content_hash",
  "raw_hash",
  "source_hash",
]);

export const WRITER_REASONS = {
  "external-id-write":
    "Writes a row keyed by an external id without the change marker; store and compare one on upsert.",
  "external-id-dedupe-key":
    "Builds a dedupe key from an external id alone; include the change marker so a changed record notifies again.",
  "external-id-table":
    "Declares an external_id column without a change-marker column; add one and compare it on upsert.",
} as const;
type WriterKind = keyof typeof WRITER_REASONS;

export const parseBaseline = (text: string, label: string): Baseline => {
  const parsed = v.safeParse(BASELINE_SCHEMA, JSON.parse(text));
  return parsed.success
    ? parsed.output
    : panic(
        `${label} must hold fingerprints and reasoned drivers, files and writers`,
      );
};

/** Membership keys across sections, prefixed so sections cannot trade rows. */
export const ledgerKeys = (baseline: Baseline): string[] =>
  SECTIONS.flatMap((section) =>
    Object.keys(baseline[section]).map((key) => `${section}:${key}`),
  );

// ── writers: external-id rows and dedupe keys ─────────────────────────────

type SourceFile = { path: string; source: string };
type WriterMember = { key: string; kind: WriterKind };

const propertyNameOf = (name: ts.PropertyName): string | null =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;

const enclosingName = (node: ts.Node): string => {
  const names: string[] = [];
  // Ancestors up to the source file, the root of every parsed node.
  for (
    let current = node.parent;
    !ts.isSourceFile(current);
    current = current.parent
  ) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isClassDeclaration(current)) &&
      current.name !== undefined
    ) {
      names.unshift(current.name.getText());
    } else if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name)
    ) {
      names.unshift(current.name.text);
    }
  }
  return names.length === 0 ? "module" : names.join("/");
};

const isNullValue = (node: ts.Expression): boolean =>
  node.kind === ts.SyntaxKind.NullKeyword ||
  (ts.isTaggedTemplateExpression(node) &&
    /^\s*NULL\s*$/iu.test(node.template.getText().slice(1, -1)));

/** Whether an identifier or property in `node` names one of `names`. */
const mentions = (node: ts.Node, names: ReadonlySet<string>): boolean => {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) {
      return;
    }
    if (ts.isIdentifier(child) && names.has(child.text)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
};

const EXTERNAL_ID = new Set(["externalId"]);

// Each credit below names an imported owner and one reviewed write site.
// Canonical AST slices pin its identity protocol and referenced import targets,
// not unrelated declarations, table policies, comments or formatting. Changes to
// the actual receipt/creation/hash contract revoke credit until it is reviewed
// again; never refresh these pins merely to clear CI. Actual-source mutation
// tests retain the negative proof. These are not census debt exceptions.
type IdentityEvidenceSlice = {
  declarations?: readonly string[];
  imports?: readonly string[];
  calls?: readonly { declaration: string; names: readonly string[] }[];
  fields?: readonly { declaration: string; names: readonly string[] }[];
  tables?: readonly string[];
  indexes?: readonly { declaration: string; name: string }[];
  exportModules?: readonly string[];
  exportBindings?: readonly string[];
  packageExports?: readonly string[];
};

export const OWNED_IDENTITY_PROTOCOL_SLICES: Readonly<
  Record<string, IdentityEvidenceSlice>
> = {
  "apps/api/src/handlers/contacts/import.ts": {
    imports: ["importContactRows"],
  },
  "apps/api/src/handlers/contacts/import-contacts.ts": {
    declarations: ["importContactRows", "writeImportRows"],
  },
  "apps/api/src/handlers/contacts/contact-import-receipt.ts": {
    declarations: [
      "CONTACT_IMPORT_RECEIPT_VERSION",
      "compareKeys",
      "canonicalJson",
      "fingerprintContactImport",
    ],
  },
  "apps/api/src/handlers/contacts/contact-capacity.ts": {
    declarations: ["lockContactCapacity"],
  },
  "apps/api/src/handlers/contacts/create.ts": {
    declarations: ["insertContactRow", "createContactHandler"],
  },
  "apps/api/src/handlers/contacts/routes.ts": {
    imports: ["createContact"],
  },
  "apps/api/src/db/schema/contacts.ts": {
    tables: ["contacts", "contactImportRequests"],
    calls: [
      {
        declaration: "contacts",
        names: ["importProvenanceColumns", "importProvenanceConstraints"],
      },
    ],
    fields: [
      {
        declaration: "contactImportRequests",
        names: [
          "organizationId",
          "userId",
          "idempotencyKey",
          "requestFingerprint",
          "result",
        ],
      },
    ],
    indexes: [
      {
        declaration: "contactImportRequests",
        name: "contact_import_requests_org_user_key_uidx",
      },
    ],
  },
  "apps/api/src/db/import-provenance-columns.ts": {
    declarations: ["importProvenanceColumns", "importProvenanceConstraints"],
  },
  "apps/api/src/lib/imports/upsert-by-external-id.ts": {
    declarations: [
      "externalRefConflict",
      "excluded",
      "upsertOutcome",
      "readExternalRefIds",
    ],
  },
  "apps/api/src/lib/imports/external-ref.ts": {
    declarations: ["externalRefKey", "externalRefFromColumns"],
  },
  "apps/api/src/lib/uploads/file-metadata-schema.ts": {
    declarations: ["documentUploadFileFields", "tUploadFileSize"],
  },
  "apps/api/src/lib/uploads/import-origin.ts": {
    declarations: ["canonicalInstant", "importDocumentSource"],
  },
  "apps/api/src/handlers/uploads/create.ts": {
    declarations: [
      "entityCreatePresignBodySchema",
      "toPurposeData",
      "presignUpload",
    ],
  },
  "apps/api/src/handlers/uploads/update.ts": {
    declarations: ["claimAndFinalize", "runFinalize"],
  },
  "apps/api/src/lib/uploads/entity-create.ts": {
    declarations: ["finalizeEntityCreate"],
  },
  "apps/api/src/lib/entity-versions/insert-entity-version.ts": {
    declarations: [
      "withVerificationCode",
      "insertEntityVersions",
      "insertPendingEntityVersions",
      "insertEntityVersion",
    ],
  },
  "apps/api/src/lib/files/file-object-ids.ts": {
    declarations: ["fileContentWithMintedObject"],
  },
  "apps/api/src/db/schema/entities.ts": {
    tables: ["pendingUploads", "entityVersions", "fields"],
    fields: [
      {
        declaration: "pendingUploads",
        names: ["declaredSha256", "purposeData"],
      },
      {
        declaration: "entityVersions",
        names: ["source"],
      },
      {
        declaration: "fields",
        names: ["content"],
      },
    ],
  },
  "apps/api/src/db/schema.ts": {
    exportModules: ["./schema/contacts", "./schema/entities"],
    exportBindings: [
      "contacts",
      "contactImportRequests",
      "pendingUploads",
      "entityVersions",
      "fields",
    ],
  },
  "apps/api/src/db/schema/common.ts": {
    declarations: ["safeOrganizationId", "pUuid"],
    exportBindings: ["p", "jsonb", "timestamptz"],
  },
  "apps/api/src/db/columns.ts": {
    declarations: ["jsonb", "timestamptz"],
  },
  "packages/sha256/src/bun.ts": {
    declarations: ["createSha256", "sha256Hex"],
  },
  "packages/sha256/src/encoding.ts": {
    declarations: ["sha256Base64ToHex", "sha256HexToBase64"],
  },
  "packages/sha256/package.json": {
    packageExports: [".", "./bun"],
  },
};

const OWNED_PROTOCOL_MODULE_PINS: Readonly<Record<string, string>> = {
  "apps/api/src/lib/uploads/file-metadata-schema.ts":
    "baa45f3ccffd6ea08e5ce2c22c51e6360ae46eb45cd537144baa1ff71db10231",
  "apps/api/src/db/schema/common.ts":
    "fcff76e8607397d65c0c5ebcf92a4d102dfa669e64a9ef154abec0760589f161",
  "apps/api/src/db/columns.ts":
    "39d57190f6c39278f2f5bf012cc024a9b40d48fef84dfb1e638149b776b2ef7d",
  "apps/api/src/handlers/contacts/import.ts":
    "9b90f7d77456f7cc816d450f9d293f5da15d67ad62aafcb06ff802ec60582d7b",
  "apps/api/src/handlers/contacts/import-contacts.ts":
    "867cd2273f9d30dc70fe9bd18247a87541467aa936feb5e66dac729875a85450",
  "apps/api/src/handlers/contacts/contact-import-receipt.ts":
    "26233d2b98fcf3894e0dc890216801a6410905e2a5adfa46e22cbc6c8dce3e46",
  "apps/api/src/handlers/contacts/contact-capacity.ts":
    "696b2e9de3094a4c65c4a777994cf01ef9a964ac303f258fab6a5bba10a8040c",
  "apps/api/src/handlers/contacts/create.ts":
    "d018142de1a6842a94541a412e0011c71a16a11d27611c77c748aec550a17c49",
  "apps/api/src/handlers/contacts/routes.ts":
    "c162dfe9417a4f2fc3950548dc5abee0e3033fa3d49dba9ac361b3cf48346b80",
  "apps/api/src/db/schema/contacts.ts":
    "eb33fe8d692da41d7b04099d43cdc285ae05345fd6aed277e3e8e132d3a8107a",
  "apps/api/src/db/import-provenance-columns.ts":
    "fbadf940249c58ffe82620789414e332cf0b2598029089dc4aa0c124de501d43",
  "apps/api/src/lib/imports/upsert-by-external-id.ts":
    "4d06187511d49b7195df3fb0bca0875141d407ddfec27b1841c04f3550d68ecd",
  "apps/api/src/lib/imports/external-ref.ts":
    "9f9022239c5a2e4c7208b0d08635cdece902434f58f51e4db228b360ffec7249",
  "apps/api/src/lib/uploads/import-origin.ts":
    "39e8dd327437e2e68f75a77bb3e789a4eeac5c9dcc6de75ba653661ab9ddc68e",
  "apps/api/src/handlers/uploads/create.ts":
    "abbc1840032382d931946072dbf75b33bfaa654f4ef867339b70a9154823e1b0",
  "apps/api/src/handlers/uploads/update.ts":
    "4a53022faaee0daca437e4ccb653400468ba9fbe69b5fa77a9caf3b8c77df790",
  "apps/api/src/lib/uploads/entity-create.ts":
    "278b7c50ae0b252337ed9ed3394f1ed7f6bb1dce0708159bf66ac7d2281ec838",
  "apps/api/src/lib/entity-versions/insert-entity-version.ts":
    "0b3dd03326d12e7130cb67c922674f7e3c41c6e72a36df7fd392639e345ff624",
  "apps/api/src/lib/files/file-object-ids.ts":
    "4af19a1fa0ed38304d738278c1b3fdea8a0f0481f9cd65962b75b7081aae64ac",
  "apps/api/src/db/schema/entities.ts":
    "fd5746d70df201c5236933bf29d0668a6bc10475ddf6597d25350c9bf05dceaa",
  "apps/api/src/db/schema.ts":
    "8766ba73717111aec64f1d3df70ebd78a672941e558f7a3cacb1e1ecade925b1",
  "packages/sha256/src/bun.ts":
    "2fb69b11c0a39518d8688e3dbf826ef3bfd66a9ff60918f3b95787a3a5429e91",
  "packages/sha256/src/encoding.ts":
    "1be91d2299cdc07a35aafd7e49948d3408504429c1714e3f10a08e35c3c2e3c4",
  "packages/sha256/package.json":
    "252e79930556a2244b5ddacb793586714c279005b9f2515b0baf1a4b7a6973d4",
};

const printer = ts.createPrinter({
  removeComments: true,
  newLine: ts.NewLineKind.LineFeed,
});

const canonicalSyntax = (node: ts.Node, sourceFile: ts.SourceFile) => {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    printer.printNode(ts.EmitHint.Unspecified, node, sourceFile),
  );
  const tokens: { kind: ts.SyntaxKind; value: string }[] = [];
  for (
    let kind = scanner.scan();
    kind !== ts.SyntaxKind.EndOfFileToken;
    kind = scanner.scan()
  ) {
    tokens.push({
      kind,
      value:
        kind === ts.SyntaxKind.StringLiteral
          ? scanner.getTokenValue()
          : scanner.getTokenText(),
    });
  }
  // Quasi whitespace and regular-expression text are data, even where a
  // standalone scanner would otherwise treat their characters as trivia.
  const literalSyntax: string[] = [];
  const visit = (child: ts.Node): void => {
    if (
      ts.isTemplateLiteralToken(child) ||
      ts.isRegularExpressionLiteral(child)
    ) {
      literalSyntax.push(child.getText(sourceFile));
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return { tokens, literalSyntax };
};

type ProtocolDeclarations = ReadonlyMap<string, ts.Node>;
type SelectorOptions = {
  slice: IdentityEvidenceSlice;
  declarations: ProtocolDeclarations;
};
type ProtocolExportIdentity = {
  name: string;
  local: string;
  from: string | null;
  typeOnly: boolean;
};

const visitMatching = (root: ts.Node, matches: (node: ts.Node) => boolean) => {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (matches(node)) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
};

const protocolDeclarations = (parsed: ts.SourceFile) => {
  const declarations = new Map<string, ts.Node>();
  for (const statement of parsed.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          declarations.set(declaration.name.text, declaration);
        }
      }
    } else if (
      ts.isFunctionDeclaration(statement) &&
      statement.name !== undefined
    ) {
      declarations.set(statement.name.text, statement);
    }
  }
  return declarations;
};

const declaredEvidence = ({
  slice,
  declarations,
}: SelectorOptions): ts.Node[] | null => {
  const selected: ts.Node[] = [];
  for (const name of slice.declarations ?? []) {
    const declaration = declarations.get(name);
    if (declaration === undefined) {
      return null;
    }
    selected.push(declaration);
  }
  return selected;
};

const tablesEvidence = ({
  slice,
  declarations,
}: SelectorOptions): ts.Node[] | null => {
  const selected: ts.Node[] = [];
  for (const name of slice.tables ?? []) {
    const declaration = declarations.get(name);
    if (declaration === undefined) {
      return null;
    }
    const calls = visitMatching(
      declaration,
      (node) =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "pgTable",
    );
    const table = calls.at(0);
    if (
      calls.length !== 1 ||
      table === undefined ||
      !ts.isCallExpression(table)
    ) {
      return null;
    }
    const tableName = table.arguments.at(0);
    if (tableName === undefined || !ts.isStringLiteral(tableName)) {
      return null;
    }
    selected.push(table.expression, tableName);
  }
  return selected;
};

const callsEvidence = ({
  slice,
  declarations,
}: SelectorOptions): ts.Node[] | null => {
  const selected: ts.Node[] = [];
  for (const owner of slice.calls ?? []) {
    const declaration = declarations.get(owner.declaration);
    if (declaration === undefined) {
      return null;
    }
    for (const name of owner.names) {
      const calls = visitMatching(
        declaration,
        (node) =>
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === name,
      );
      if (calls.length !== 1) {
        return null;
      }
      selected.push(...calls);
    }
  }
  return selected;
};

const fieldsEvidence = ({
  slice,
  declarations,
}: SelectorOptions): ts.Node[] | null => {
  const selected: ts.Node[] = [];
  for (const owner of slice.fields ?? []) {
    const declaration = declarations.get(owner.declaration);
    if (declaration === undefined) {
      return null;
    }
    for (const name of owner.names) {
      const fields = visitMatching(
        declaration,
        (node) =>
          ts.isPropertyAssignment(node) && propertyNameOf(node.name) === name,
      );
      if (fields.length !== 1) {
        return null;
      }
      selected.push(...fields);
    }
  }
  return selected;
};

const indexesEvidence = ({
  slice,
  declarations,
}: SelectorOptions): ts.Node[] | null => {
  const selected: ts.Node[] = [];
  for (const owner of slice.indexes ?? []) {
    const declaration = declarations.get(owner.declaration);
    if (declaration === undefined) {
      return null;
    }
    const calls = visitMatching(
      declaration,
      (node) =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "uniqueIndex" &&
        node.arguments.some(
          (argument) =>
            ts.isStringLiteral(argument) && argument.text === owner.name,
        ),
    );
    if (calls.length !== 1) {
      return null;
    }
    let index = calls.at(0);
    if (index === undefined) {
      return null;
    }
    // Retain the complete .on/.where chain, not merely the index's name.
    while (
      ts.isPropertyAccessExpression(index.parent) &&
      index.parent.expression === index &&
      ts.isCallExpression(index.parent.parent) &&
      index.parent.parent.expression === index.parent
    ) {
      index = index.parent.parent;
    }
    selected.push(index);
  }
  return selected;
};

const protocolExports = ({
  parsed,
  slice,
}: {
  parsed: ts.SourceFile;
  slice: IdentityEvidenceSlice;
}) => {
  const selected: ts.Node[] = [];
  const exports: ProtocolExportIdentity[] = [];
  for (const statement of parsed.statements) {
    if (!ts.isExportDeclaration(statement)) {
      continue;
    }
    const fromOwner =
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      slice.exportModules?.includes(statement.moduleSpecifier.text) === true;
    const names =
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
        ? statement.exportClause.elements.filter(
            (element) =>
              slice.exportBindings?.includes(element.name.text) === true,
          )
        : [];
    if (fromOwner) {
      selected.push(statement);
    } else {
      for (const element of names) {
        exports.push({
          name: element.name.text,
          local: element.propertyName?.text ?? element.name.text,
          from:
            statement.moduleSpecifier !== undefined &&
            ts.isStringLiteral(statement.moduleSpecifier)
              ? statement.moduleSpecifier.text
              : null,
          typeOnly: statement.isTypeOnly || element.isTypeOnly,
        });
      }
    }
  }
  for (const module of slice.exportModules ?? []) {
    if (
      !selected.some(
        (node) =>
          ts.isExportDeclaration(node) &&
          node.moduleSpecifier !== undefined &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text === module,
      )
    ) {
      return null;
    }
  }
  return { selected, exports };
};

const protocolImports = ({
  parsed,
  slice,
  selected,
  exports,
}: {
  parsed: ts.SourceFile;
  slice: IdentityEvidenceSlice;
  selected: readonly ts.Node[];
  exports: readonly ProtocolExportIdentity[];
}) => {
  const references = new Set([
    ...(slice.imports ?? []),
    ...exports.map(({ local }) => local),
  ]);
  for (const node of selected) {
    const visit = (child: ts.Node): void => {
      if (ts.isIdentifier(child)) {
        references.add(child.text);
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
  }
  const imports: {
    from: string;
    imported: string;
    local: string;
    typeOnly: boolean;
  }[] = [];
  for (const statement of parsed.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (clause === undefined) {
      continue;
    }
    const from = statement.moduleSpecifier.text;
    const add = ({
      local,
      imported,
      typeOnly = clause.phaseModifier === ts.SyntaxKind.TypeKeyword,
    }: {
      local: string;
      imported: string;
      typeOnly?: boolean;
    }) => {
      if (references.has(local)) {
        imports.push({ from, imported, local, typeOnly });
      }
    };
    if (clause.name !== undefined) {
      add({ local: clause.name.text, imported: "default" });
    }
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      add({ local: bindings.name.text, imported: "*" });
    }
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        add({
          local: element.name.text,
          imported: element.propertyName?.text ?? element.name.text,
          typeOnly:
            clause.phaseModifier === ts.SyntaxKind.TypeKeyword ||
            element.isTypeOnly,
        });
      }
    }
  }
  if (
    (slice.imports ?? []).some(
      (name) => !imports.some(({ local }) => local === name),
    )
  ) {
    return null;
  }
  return imports.toSorted((left, right) =>
    compareCodeUnit(left.local, right.local),
  );
};

const packageExportPin = (
  source: string,
  packageExports: readonly string[],
) => {
  const parsed: unknown = JSON.parse(source);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("exports" in parsed) ||
    typeof parsed.exports !== "object" ||
    parsed.exports === null
  ) {
    return null;
  }
  const exports = parsed.exports;
  const targets = packageExports.map((key) =>
    Object.hasOwn(exports, key) ? Reflect.get(exports, key) : undefined,
  );
  if (targets.some((target) => typeof target !== "string")) {
    return null;
  }
  return sha256Hex(JSON.stringify(targets));
};

/** Bounded declaration/import selection, with no inferred runtime control flow. */
export const ownedProtocolSourcePin = ({
  path: file,
  source,
  slice,
}: SourceFile & { slice: IdentityEvidenceSlice }): string | null => {
  if (slice.packageExports !== undefined) {
    return packageExportPin(source, slice.packageExports);
  }
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const declarations = protocolDeclarations(parsed);
  const selected: ts.Node[] = [];
  for (const select of [
    declaredEvidence,
    tablesEvidence,
    callsEvidence,
    fieldsEvidence,
    indexesEvidence,
  ]) {
    const evidence = select({ slice, declarations });
    if (evidence === null) {
      return null;
    }
    selected.push(...evidence);
  }
  const exported = protocolExports({ parsed, slice });
  if (exported === null) {
    return null;
  }
  selected.push(...exported.selected);
  const imports = protocolImports({
    parsed,
    slice,
    selected,
    exports: exported.exports,
  });
  if (imports === null) {
    return null;
  }
  const declarationEvidence = selected.map((node) => {
    let owner = node;
    while (!ts.isSourceFile(owner) && !ts.isVariableDeclarationList(owner)) {
      owner = owner.parent;
    }
    return {
      syntax: canonicalSyntax(node, parsed),
      bindingKind: ts.isVariableDeclarationList(owner) ? owner.flags : null,
    };
  });
  return sha256Hex(
    JSON.stringify({
      declarations: declarationEvidence,
      exports: exported.exports,
      imports,
    }),
  );
};

const COMMON_CONTACT_IDENTITY_MODULES = [
  "apps/api/src/db/schema/common.ts",
  "apps/api/src/db/columns.ts",
  "apps/api/src/handlers/contacts/contact-capacity.ts",
  "apps/api/src/db/schema/contacts.ts",
  "apps/api/src/db/import-provenance-columns.ts",
  "apps/api/src/db/schema.ts",
  "apps/api/src/lib/imports/upsert-by-external-id.ts",
  "apps/api/src/lib/imports/external-ref.ts",
];
const OWNED_IDENTITY_PROTOCOLS = [
  {
    invariant:
      "A synchronous manual batch compares and stores its canonical request fingerprint in the same capacity-locked transaction as its writes.",
    consumer: "apps/api/src/handlers/contacts/import.ts",
    binding: "importContactRows",
    boundaries: [
      {
        file: "apps/api/src/handlers/contacts/import-contacts.ts",
        binding: "writeImportRows",
        declarations: ["importContactRows"],
        exposure: "private",
      },
    ],
    scopes: ["writeImportRows/toContactValues", "writeImportRows/upserted"],
    modules: [
      ...COMMON_CONTACT_IDENTITY_MODULES,
      "apps/api/src/handlers/contacts/import.ts",
      "apps/api/src/handlers/contacts/import-contacts.ts",
      "apps/api/src/handlers/contacts/contact-import-receipt.ts",
      "packages/sha256/src/bun.ts",
      "packages/sha256/package.json",
    ],
  },
  {
    invariant:
      "Contact creation inserts a fresh row only and refuses an existing tenant-scoped external identity; it never updates a matched row.",
    consumer: "apps/api/src/handlers/contacts/routes.ts",
    binding: "createContact",
    boundaries: [],
    scopes: ["insertContactRow"],
    modules: [
      ...COMMON_CONTACT_IDENTITY_MODULES,
      "apps/api/src/handlers/contacts/routes.ts",
      "apps/api/src/handlers/contacts/create.ts",
    ],
  },
  {
    invariant:
      "Imported provenance describes an immutable new document version whose verified byte SHA-256 is persisted with its file metadata.",
    consumer: "apps/api/src/handlers/uploads/create.ts",
    binding: "importDocumentSource",
    exclusiveConsumer: "toPurposeData",
    boundaries: [],
    scopes: ["importDocumentSource"],
    modules: [
      "apps/api/src/handlers/uploads/create.ts",
      "apps/api/src/lib/uploads/import-origin.ts",
      "apps/api/src/lib/uploads/file-metadata-schema.ts",
      "apps/api/src/handlers/uploads/update.ts",
      "apps/api/src/lib/uploads/entity-create.ts",
      "apps/api/src/lib/entity-versions/insert-entity-version.ts",
      "apps/api/src/lib/files/file-object-ids.ts",
      "apps/api/src/db/schema/entities.ts",
      "apps/api/src/db/schema/common.ts",
      "apps/api/src/db/columns.ts",
      "apps/api/src/db/schema.ts",
      "packages/sha256/src/bun.ts",
      "packages/sha256/src/encoding.ts",
      "packages/sha256/package.json",
    ],
  },
];

export const OWNED_IDENTITY_PROTOCOL_SOURCE_PATHS = Object.keys(
  OWNED_PROTOCOL_MODULE_PINS,
);

const resolvedModule = (consumer: string, specifier: string): string | null => {
  const stem = specifier.replace(/\.(?:ts|js)$/u, "");
  if (stem.startsWith("@/api/")) {
    return path.posix.normalize(
      `apps/api/src/${stem.slice("@/api/".length)}.ts`,
    );
  }
  return stem.startsWith(".")
    ? path.posix.normalize(
        path.posix.join(path.posix.dirname(consumer), `${stem}.ts`),
      )
    : null;
};

type ReferenceBoundary = {
  file: string;
  binding: string;
  declarations: readonly string[];
  exposure: string;
};

// A syntax boundary, not value-flow inference: aliases and references outside
// reviewed declarations revoke credit. The caller bodies themselves are pinned.
const referencesStayOwned = (file: SourceFile, boundary: ReferenceBoundary) => {
  const parsed = ts.createSourceFile(
    file.path,
    file.source,
    ts.ScriptTarget.Latest,
    true,
  );
  let valid = true;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === boundary.binding) {
      const parent = node.parent;
      if (ts.isImportSpecifier(parent) || ts.isImportClause(parent)) {
        return;
      }
      if (ts.isVariableDeclaration(parent) && parent.name === node) {
        if (
          boundary.exposure === "private" &&
          ts.isVariableDeclarationList(parent.parent) &&
          ts.isVariableStatement(parent.parent.parent) &&
          parent.parent.parent.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
          ) === true
        ) {
          valid = false;
        }
        return;
      }
      let owner: ts.Node = node;
      while (!ts.isSourceFile(owner)) {
        if (
          ts.isVariableDeclaration(owner) &&
          ts.isIdentifier(owner.name) &&
          boundary.declarations.includes(owner.name.text) &&
          ts.isVariableDeclarationList(owner.parent) &&
          ts.isVariableStatement(owner.parent.parent) &&
          ts.isSourceFile(owner.parent.parent.parent)
        ) {
          return;
        }
        owner = owner.parent;
      }
      valid = false;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return valid;
};

const MODULE_LOADERS = new Set(["node:module", "module"]);

type ExclusiveConsumer = {
  owner: string;
  consumer: string;
  binding: string;
  declaration: string;
};

type ModuleReference = {
  node: ts.Node;
  file: string;
  boundary: ExclusiveConsumer;
};

const importEscapesConsumer = ({ node, file, boundary }: ModuleReference) => {
  if (
    !ts.isImportDeclaration(node) ||
    !ts.isStringLiteral(node.moduleSpecifier) ||
    node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
  ) {
    return false;
  }
  if (MODULE_LOADERS.has(node.moduleSpecifier.text)) {
    return true;
  }
  if (resolvedModule(file, node.moduleSpecifier.text) !== boundary.owner) {
    return false;
  }
  const clause = node.importClause;
  const named = clause?.namedBindings;
  const consumes =
    clause?.name !== undefined ||
    (named !== undefined &&
      (ts.isNamespaceImport(named) ||
        named.elements.some(
          (element) =>
            !element.isTypeOnly &&
            (element.propertyName?.text ?? element.name.text) ===
              boundary.binding,
        )));
  return (
    consumes &&
    (file !== boundary.consumer ||
      clause?.name !== undefined ||
      named === undefined ||
      ts.isNamespaceImport(named) ||
      named.elements.some(
        (element) =>
          !element.isTypeOnly &&
          (element.propertyName?.text ?? element.name.text) ===
            boundary.binding &&
          element.name.text !== boundary.binding,
      ))
  );
};

const exportEscapesConsumer = ({ node, file, boundary }: ModuleReference) => {
  if (
    !ts.isExportDeclaration(node) ||
    node.isTypeOnly ||
    node.moduleSpecifier === undefined ||
    !ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return false;
  }
  if (MODULE_LOADERS.has(node.moduleSpecifier.text)) {
    return true;
  }
  if (resolvedModule(file, node.moduleSpecifier.text) !== boundary.owner) {
    return false;
  }
  const named = node.exportClause;
  return (
    named === undefined ||
    !ts.isNamedExports(named) ||
    named.elements.some(
      (element) =>
        !element.isTypeOnly &&
        (element.propertyName?.text ?? element.name.text) === boundary.binding,
    )
  );
};

const runtimeLoaderEscapesConsumer = ({
  node,
  file,
  boundary,
}: ModuleReference) => {
  if (
    !ts.isCallExpression(node) ||
    !(
      node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require")
    )
  ) {
    return false;
  }
  const specifier = node.arguments.at(0);
  return (
    specifier === undefined ||
    !ts.isStringLiteral(specifier) ||
    resolvedModule(file, specifier.text) === boundary.owner ||
    MODULE_LOADERS.has(specifier.text)
  );
};

const consumerClosureOwned = (
  files: readonly SourceFile[],
  boundary: ExclusiveConsumer,
) => {
  for (const file of files) {
    if (!file.path.endsWith(".ts")) {
      continue;
    }
    if (
      (file.path === boundary.consumer || file.path === boundary.owner) &&
      !referencesStayOwned(file, {
        file: file.path,
        binding: boundary.binding,
        declarations:
          file.path === boundary.consumer ? [boundary.declaration] : [],
        exposure: "public",
      })
    ) {
      return false;
    }
    const parsed = ts.createSourceFile(
      file.path,
      file.source,
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): boolean => {
      // This proof covers canonical static module syntax, not eval, VM code
      // or arbitrary global reflection. Escaping runtime loaders are unknown.
      const escapingRequire =
        ts.isIdentifier(node) &&
        node.text === "require" &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node);
      const reference = { node, file: file.path, boundary };
      if (
        escapingRequire ||
        importEscapesConsumer(reference) ||
        exportEscapesConsumer(reference) ||
        runtimeLoaderEscapesConsumer(reference)
      ) {
        return true;
      }
      return ts.forEachChild(node, visit) === true;
    };
    if (visit(parsed)) {
      return false;
    }
  }
  return true;
};

const importedOwner = (
  { path: consumer, source }: SourceFile,
  binding: string,
): string | null => {
  const parsed = ts.createSourceFile(
    consumer,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of parsed.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
    ) {
      continue;
    }
    const clause = statement.importClause;
    const named = clause?.namedBindings;
    const matches =
      clause?.name?.text === binding ||
      (named !== undefined &&
        ts.isNamedImports(named) &&
        named.elements.some(
          (element) => !element.isTypeOnly && element.name.text === binding,
        ));
    if (!matches) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    return resolvedModule(consumer, specifier);
  }
  return null;
};

const verifiedOwnedSites = (
  files: readonly SourceFile[],
): ReadonlySet<string> => {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const digests = new Map<string, string>();
  const verified = new Set<string>();
  for (const protocol of OWNED_IDENTITY_PROTOCOLS) {
    const consumer = byPath.get(protocol.consumer);
    if (consumer === undefined) {
      continue;
    }
    const owner = importedOwner(consumer, protocol.binding);
    if (owner === null || !protocol.modules.includes(owner)) {
      continue;
    }
    if (
      !protocol.boundaries.every((boundary) => {
        const source = byPath.get(boundary.file);
        return source !== undefined && referencesStayOwned(source, boundary);
      })
    ) {
      continue;
    }
    if (
      "exclusiveConsumer" in protocol &&
      !consumerClosureOwned(files, {
        owner,
        consumer: protocol.consumer,
        binding: protocol.binding,
        declaration: protocol.exclusiveConsumer,
      })
    ) {
      continue;
    }
    const proven = protocol.modules.every((file) => {
      const input = byPath.get(file);
      if (input === undefined) {
        return false;
      }
      const slice = OWNED_IDENTITY_PROTOCOL_SLICES[file];
      if (slice === undefined) {
        return false;
      }
      const digest =
        digests.get(file) ?? ownedProtocolSourcePin({ ...input, slice });
      if (digest === null) {
        return false;
      }
      digests.set(file, digest);
      return digest === OWNED_PROTOCOL_MODULE_PINS[file];
    });
    if (proven) {
      for (const scope of protocol.scopes) {
        verified.add(`${owner}::${scope}`);
      }
    }
  }
  return verified;
};

const SCHEMA_CONSTRUCTORS: Readonly<Record<string, ReadonlySet<string>>> = {
  valibot: new Set(["string", "nullable", "optional", "pipe"]),
  "drizzle-orm/pg-core": new Set(["varchar", "text"]),
};

const schemaNamespaces = (sourceFile: ts.SourceFile) => {
  const namespaces = new Map<string, ReadonlySet<string>>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
    ) {
      continue;
    }
    const constructors = SCHEMA_CONSTRUCTORS[statement.moduleSpecifier.text];
    const binding = statement.importClause?.namedBindings;
    if (
      constructors !== undefined &&
      binding !== undefined &&
      ts.isNamespaceImport(binding)
    ) {
      namespaces.set(binding.name.text, constructors);
    }
  }
  // Do not infer lexical value flow. Any local redeclaration makes that
  // namespace ambiguous for this scan, including destructuring and catch/loop bindings.
  const visit = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name)
    ) {
      namespaces.delete(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return namespaces;
};

const isSchemaExpression = (
  node: ts.Expression,
  namespaces: ReadonlyMap<string, ReadonlySet<string>>,
) =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  namespaces
    .get(node.expression.expression.text)
    ?.has(node.expression.name.text) === true;

const isReadOrSchemaIdentity = ({
  identities,
  namespaces,
}: {
  identities: readonly ts.ObjectLiteralElementLike[];
  namespaces: ReadonlyMap<string, ReadonlySet<string>>;
}) => {
  if (
    identities.every(
      (property) =>
        ts.isPropertyAssignment(property) &&
        (property.initializer.kind === ts.SyntaxKind.TrueKeyword ||
          property.initializer.kind === ts.SyntaxKind.FalseKeyword),
    )
  ) {
    return true;
  }
  if (
    identities.every(
      (property) =>
        ts.isPropertyAssignment(property) &&
        isSchemaExpression(property.initializer, namespaces),
    )
  ) {
    return true;
  }
  // Unknown method names are not evidence of a read: a custom .returning or
  // .select may consume values. Actual canonical protocol sites are proved above.
  return false;
};

const writesUnmarkedExternalIdentity = ({
  properties,
  namespaces,
}: {
  properties: ReadonlyMap<string, ts.ObjectLiteralElementLike>;
  namespaces: ReadonlyMap<string, ReadonlySet<string>>;
}) => {
  const externalSource = properties.get("externalSource");
  const externalId = properties.get("externalId");
  const writesExternalId =
    externalSource !== undefined &&
    externalId !== undefined &&
    !isReadOrSchemaIdentity({
      identities: [externalSource, externalId],
      namespaces,
    }) &&
    !(
      ts.isPropertyAssignment(externalId) && isNullValue(externalId.initializer)
    );
  return (
    writesExternalId &&
    ![...CHANGE_MARKERS].some((marker) => properties.has(marker))
  );
};

const writerMembersOf = (
  { path: file, source }: SourceFile,
  ownedSites: ReadonlySet<string>,
): WriterMember[] => {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const members: WriterMember[] = [];
  const namespaces = schemaNamespaces(sourceFile);
  // A second write of the same kind in one function gets its own ordinal key
  // (`#2`, …), so it is a new member rather than a duplicate of a listed one.
  const seen = new Map<string, number>();
  const add = (node: ts.Node, kind: WriterKind, name = enclosingName(node)) => {
    const base = `${file}::${kind}::${name}`;
    const ordinal = (seen.get(base) ?? 0) + 1;
    seen.set(base, ordinal);
    members.push({
      key: ordinal === 1 ? base : `${base}#${ordinal}`,
      kind,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const properties = new Map<string, ts.ObjectLiteralElementLike>();
      for (const property of node.properties) {
        const name =
          property.name === undefined ? null : propertyNameOf(property.name);
        if (name !== null) {
          properties.set(name, property);
        }
      }
      if (
        writesUnmarkedExternalIdentity({ properties, namespaces }) &&
        !ownedSites.has(`${file}::${enclosingName(node)}`)
      ) {
        add(node, "external-id-write");
      }
      const dedupe = properties.get("dedupeKey");
      if (
        dedupe !== undefined &&
        ts.isPropertyAssignment(dedupe) &&
        mentions(dedupe.initializer, EXTERNAL_ID) &&
        !mentions(dedupe.initializer, CHANGE_MARKERS)
      ) {
        add(dedupe, "external-id-dedupe-key");
      }
    }
    const isDedupeFunctionDeclaration =
      ts.isFunctionDeclaration(node) &&
      node.name?.text.endsWith("DedupeKey") === true;
    const isDedupeFunctionVariable =
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text.endsWith("DedupeKey") &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer));
    const dedupeFunction =
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      (isDedupeFunctionDeclaration || isDedupeFunctionVariable)
        ? node
        : undefined;
    if (
      dedupeFunction !== undefined &&
      mentions(dedupeFunction, EXTERNAL_ID) &&
      !mentions(dedupeFunction, CHANGE_MARKERS)
    ) {
      add(
        dedupeFunction,
        "external-id-dedupe-key",
        dedupeFunction.name?.getText() ?? "module",
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return members;
};

/** A table literal (`pgTable("name", { … })`) with an `external_id` column and no change marker. */
const tableMembersOf = ({ path: file, source }: SourceFile): WriterMember[] => {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const members: WriterMember[] = [];
  const visit = (node: ts.Node): void => {
    const [tableName, columns] = ts.isCallExpression(node)
      ? node.arguments
      : [];
    if (
      tableName !== undefined &&
      columns !== undefined &&
      ts.isStringLiteral(tableName) &&
      ts.isObjectLiteralExpression(columns)
    ) {
      const columnNames = new Set<string>();
      for (const property of columns.properties) {
        if (!ts.isPropertyAssignment(property)) {
          continue;
        }
        const first = ts.isCallExpression(property.initializer)
          ? property.initializer.arguments.at(0)
          : undefined;
        if (first !== undefined && ts.isStringLiteral(first)) {
          columnNames.add(first.text);
        }
      }
      if (
        columnNames.has("external_id") &&
        ![...CHANGE_MARKER_COLUMNS].some((column) => columnNames.has(column))
      ) {
        members.push({
          key: `${file}::external-id-table::${tableName.text}`,
          kind: "external-id-table",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return members;
};

export const scanExternalIdentity = (
  files: readonly SourceFile[],
): WriterMember[] => {
  const ownedSites = verifiedOwnedSites(files);
  return files
    .filter((file) => file.path.endsWith(".ts"))
    .flatMap((file) =>
      file.path.startsWith(`${SCHEMA_DIR}/`)
        ? [...tableMembersOf(file), ...writerMembersOf(file, ownedSites)]
        : writerMembersOf(file, ownedSites),
    )
    .toSorted((left, right) => compareCodeUnit(left.key, right.key));
};

const gitFiles = (pathspecs: readonly string[]): string[] => {
  const listed = Bun.spawnSync(["git", "ls-files", "--", ...pathspecs], {
    cwd: ROOT,
  });
  if (listed.exitCode !== 0) {
    panic(`Cannot enumerate ${pathspecs.join(", ")}`);
  }
  return listed.stdout.toString().trim().split("\n").filter(Boolean);
};

const isProductionSource = (file: string): boolean =>
  file.endsWith(".ts") &&
  !file.endsWith(".test.ts") &&
  !file.endsWith(".d.ts") &&
  !file.includes("/tests/") &&
  !file.includes("/__fixtures__/");

const writerCensus = (): WriterMember[] =>
  scanExternalIdentity(
    [
      ...new Set([
        ...gitFiles([`${API_SOURCE_DIR}/*.ts`]).filter(isProductionSource),
        ...OWNED_IDENTITY_PROTOCOL_SOURCE_PATHS,
      ]),
    ].map((file) => ({
      path: file,
      source: readFileSync(path.join(ROOT, file), "utf-8"),
    })),
  );

// ── files: the lint rule in census mode ───────────────────────────────────

const fileCensus = (): string[] => {
  const directory = mkdtempSync(path.join(tmpdir(), "source-fingerprint-"));
  const config = path.join(directory, "oxlint.config.ts");
  const report = path.join(directory, "report.json");
  const files = gitFiles([`${ADAPTERS_DIR}/*.ts`]).filter(isProductionSource);
  for (const file of files) {
    const destination = path.join(directory, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    // A suppression must not hide a member from the census.
    writeFileSync(
      destination,
      readFileSync(path.join(ROOT, file), "utf-8").replaceAll(
        /\b(?:oxlint|eslint)-(?:disable|enable)\b/gu,
        "source-fingerprint-census-directive",
      ),
    );
  }
  writeFileSync(
    config,
    `export default ${JSON.stringify({
      categories: { correctness: "off" },
      jsPlugins: [path.join(ROOT, ".oxlint-plugins", `${RULE}.ts`)],
      rules: { [`${RULE}/${RULE}`]: ["error", { census: true }] },
    })};\n`,
  );
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--bun",
      path.join(ROOT, "node_modules/oxlint/bin/oxlint"),
      "-c",
      config,
      "--format=json",
      ADAPTERS_DIR,
    ],
    { cwd: directory, stdout: Bun.file(report), stderr: "pipe" },
  );
  const output = readFileSync(report, "utf-8");
  rmSync(directory, { recursive: true, force: true });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    panic(`rawHash census failed: ${result.stderr.toString()}`);
  }
  const diagnostics = v.parse(LINT_OUTPUT, JSON.parse(output)).diagnostics;
  const flagged = new Set<string>();
  for (const { code, filename } of diagnostics) {
    if (!code.startsWith(`${RULE}(`)) {
      panic(`Unexpected rawHash census diagnostic: ${code}`);
    }
    const at = filename.indexOf(`${ADAPTERS_DIR}/`);
    flagged.add(
      at === -1 ? panic(`Census reported ${filename}`) : filename.slice(at),
    );
  }
  return [...flagged].toSorted();
};

// ── drivers: the API guard test's census ──────────────────────────────────

type DriverCensus = v.InferOutput<typeof DRIVER_CENSUS>;

const driverCensus = (): DriverCensus => {
  const directory = mkdtempSync(path.join(tmpdir(), "source-fingerprint-"));
  const out = path.join(directory, "drivers.json");
  const result = Bun.spawnSync(
    [process.execPath, "scripts/run-tests.ts", GUARD_TEST],
    {
      cwd: path.join(ROOT, "apps/api"),
      env: { ...process.env, [CENSUS_OUT_ENV]: out },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const rows =
    result.exitCode === 0 && Bun.file(out).size > 0
      ? v.parse(DRIVER_CENSUS, JSON.parse(readFileSync(out, "utf-8")))
      : panic("The source fingerprint guard test failed or wrote no census");
  rmSync(directory, { recursive: true, force: true });
  return rows;
};

// ── comparison ────────────────────────────────────────────────────────────

type SectionDifference = { added: string[]; stale: string[] };

export const sectionDifference = (
  observed: readonly string[],
  recorded: readonly string[],
): SectionDifference => {
  const actual = new Set(observed);
  const expected = new Set(recorded);
  return {
    added: [...actual].filter((key) => !expected.has(key)).toSorted(),
    stale: [...expected].filter((key) => !actual.has(key)).toSorted(),
  };
};

const readBaseline = (): Baseline =>
  parseBaseline(readFileSync(path.join(ROOT, BASELINE), "utf-8"), BASELINE);

const reasoned = (
  rows: readonly { key: string; reason: string }[],
  previous: Readonly<Record<string, string>>,
): Record<string, string> =>
  Object.fromEntries(
    rows
      .toSorted((left, right) => compareCodeUnit(left.key, right.key))
      .map(({ key, reason }) => [key, previous[key] ?? reason]),
  );

const write = (): number => {
  const previous = readBaseline();
  const census = driverCensus();
  const next: Baseline = {
    comment: previous.comment,
    drivers: reasoned(census.misses, previous.drivers),
    fingerprints: Object.fromEntries(
      census.fingerprints.map(
        ({ key, fingerprint, storedInputIdentity, version }) => [
          key,
          { fingerprint, storedInputIdentity, version },
        ],
      ),
    ),
    files: reasoned(
      fileCensus().map((key) => ({ key, reason: FILE_REASON })),
      previous.files,
    ),
    writers: reasoned(
      writerCensus().map(({ key, kind }) => ({
        key,
        reason: WRITER_REASONS[kind],
      })),
      previous.writers,
    ),
  };
  writeFileSync(
    path.join(ROOT, BASELINE),
    `${JSON.stringify(next, null, 2)}\n`,
  );
  console.log(
    `Source fingerprint baseline written: ${String(Object.keys(next.drivers).length)} drivers, ${String(Object.keys(next.files).length)} files, ${String(Object.keys(next.writers).length)} writers.`,
  );
  return 0;
};

type RecordedFingerprint = Baseline["fingerprints"][string];

export const fingerprintEvolutionFailures = (
  current: Readonly<Record<string, RecordedFingerprint>>,
  base: Readonly<Record<string, RecordedFingerprint>>,
): string[] => {
  const failures: string[] = [];
  for (const [key, recorded] of Object.entries(current)) {
    const previous = base[key];
    if (previous === undefined) {
      continue;
    }
    if (recorded.version < previous.version) {
      failures.push(`${key}: fingerprint version decreased`);
      continue;
    }
    if (
      recorded.storedInputIdentity === previous.storedInputIdentity &&
      recorded.fingerprint !== previous.fingerprint &&
      recorded.version <= previous.version
    ) {
      failures.push(
        `${key}: fixture fingerprint changed without a version bump`,
      );
    }
  }
  return failures;
};

const baselineAt = (args: readonly string[]): Baseline | null => {
  const baseIndex = args.indexOf("--base");
  const baseRef = baseIndex === -1 ? "origin/main" : args[baseIndex + 1];
  if (baseRef === undefined || baseRef === "") {
    panic("--base requires a nonempty Git reference");
  }
  const result = Bun.spawnSync(["git", "show", `${baseRef}:${BASELINE}`], {
    cwd: ROOT,
    stderr: "pipe",
  });
  if (result.exitCode === 0) {
    return parseBaseline(result.stdout.toString(), `${baseRef}:${BASELINE}`);
  }
  if (baseIndex !== -1) {
    panic(`Cannot read source fingerprint baseline at ${baseRef}`);
  }
  console.warn(
    `Source fingerprint evolution was not checked: ${baseRef}:${BASELINE} is unavailable`,
  );
  return null;
};

const check = (args: readonly string[]): number => {
  const baseline = readBaseline();
  const failures: string[] = [];
  const census = driverCensus();
  const fingerprints = Object.fromEntries(
    census.fingerprints.map(
      ({ key, fingerprint, storedInputIdentity, version }) => [
        key,
        { fingerprint, storedInputIdentity, version },
      ],
    ),
  );
  if (
    Object.keys(fingerprints).length !==
      Object.keys(baseline.fingerprints).length ||
    Object.entries(fingerprints).some(([key, current]) => {
      const recorded = baseline.fingerprints[key];
      return (
        recorded === undefined ||
        current.fingerprint !== recorded.fingerprint ||
        current.storedInputIdentity !== recorded.storedInputIdentity ||
        current.version !== recorded.version
      );
    })
  ) {
    failures.push("Fixture fingerprints are stale (run --write)");
  }
  const base = baselineAt(args);
  if (base !== null) {
    failures.push(
      ...fingerprintEvolutionFailures(baseline.fingerprints, base.fingerprints),
    );
  }
  const observed: Record<Exclude<Section, "drivers">, string[]> = {
    files: fileCensus(),
    writers: writerCensus().map(({ key }) => key),
  };
  for (const section of ["files", "writers"] as const) {
    const { added, stale } = sectionDifference(
      observed[section],
      Object.keys(baseline[section]),
    );
    failures.push(
      ...added.map((key) => `New ${section} member (use the owner): ${key}`),
      ...stale.map(
        (key) =>
          `Migrated ${section} member still listed (run --write): ${key}`,
      ),
    );
  }
  for (const failure of failures) {
    console.error(failure);
  }
  const membership = runLedgerMembershipGuard({
    ledgerRel: BASELINE,
    repoRoot: ROOT,
    parseLedger: (text, label) => ledgerKeys(parseBaseline(text, label)),
    label: "source-fingerprint",
    remediation:
      "derive rawHash with sourceFingerprint and store a change marker instead of listing a new member",
    args,
  });
  if (failures.length > 0 || membership !== 0) {
    return 1;
  }
  console.log(
    `Source fingerprint baseline: ${String(Object.keys(baseline.fingerprints).length)} fixture fingerprints, ${String(observed.files.length)} files, ${String(observed.writers.length)} writers verified.`,
  );
  return 0;
};

const SELF_TEST_SOURCES: readonly SourceFile[] = [
  {
    path: "apps/api/src/lib/example/import.ts",
    source: `
      export const importItems = (items) =>
        items.map((item) => ({ externalSource: "x", externalId: item.id }));
      export const importPair = (left, right) => [
        { externalSource: "x", externalId: left.id },
        { externalSource: "x", externalId: right.id },
      ];
      export const clearIdentity = () => ({ externalSource: null, externalId: null });
      export const syncItems = (items) =>
        items.map((item) => ({ externalSource: "x", externalId: item.id, externalChangeKey: item.etag }));
      export const itemDedupeKey = (workspaceId, externalId) => \`x:\${workspaceId}:\${externalId}\`;
      export const notify = (item) => ({ dedupeKey: \`x:\${item.externalId}\` });
      export const notifyChanged = (item) => ({ dedupeKey: \`x:\${item.externalId}:\${item.contentHash}\` });
    `,
  },
  {
    path: "apps/api/src/db/schema/example.ts",
    source: `
      export const imported = pgTable("imported", { externalId: p.text("external_id") });
      export const synced = pgTable("synced", {
        externalId: p.text("external_id"),
        externalChangeKey: p.text("external_change_key"),
      });
    `,
  },
];

const selfTest = (): number => {
  const failures: string[] = [];
  const keys = scanExternalIdentity(SELF_TEST_SOURCES).map(({ key }) => key);
  const expected = [
    "apps/api/src/db/schema/example.ts::external-id-table::imported",
    "apps/api/src/lib/example/import.ts::external-id-dedupe-key::itemDedupeKey",
    "apps/api/src/lib/example/import.ts::external-id-dedupe-key::notify",
    "apps/api/src/lib/example/import.ts::external-id-write::importItems",
    "apps/api/src/lib/example/import.ts::external-id-write::importPair",
    "apps/api/src/lib/example/import.ts::external-id-write::importPair#2",
  ];
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    failures.push(
      `scan must report exactly ${expected.join(", ")}; got ${keys.join(", ")}`,
    );
  }
  const swapped = addedEntries(
    ledgerKeys({
      comment: "",
      drivers: {},
      fingerprints: {},
      files: { "a.ts": "r" },
      writers: {},
    }),
    ledgerKeys({
      comment: "",
      drivers: { "a.ts": "r" },
      fingerprints: {},
      files: {},
      writers: {},
    }),
  );
  if (swapped.length !== 1) {
    failures.push("a row moved between sections must count as new");
  }
  for (const failure of failures) {
    console.error(`source-fingerprint --self-test: ${failure}`);
  }
  if (failures.length === 0) {
    console.log("source-fingerprint --self-test: PASS");
  }
  return failures.length === 0 ? 0 : 1;
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    process.exit(selfTest());
  }
  if (args.includes("--write")) {
    process.exit(write());
  }
  process.exit(check(args.filter((arg) => arg !== "--check")));
}
