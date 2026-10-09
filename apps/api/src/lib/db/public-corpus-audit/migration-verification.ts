import { createHash } from "node:crypto";

import { isOwnerOnlyExpression } from "./schema-verification.ts";

export type CorpusMigration = { file: string; sql: string };
export type CorpusDeclaration = {
  schemaExport: string;
  sqlName: string;
  moduleId: string;
  purpose: string;
  reason: string;
  columns: Readonly<Record<string, { kind: string; reason: string }>>;
};
export type CorpusAttestation = {
  schemaExport: string;
  declarationDigest: string;
  schemaDigest: string;
  migrationDigest: string;
  statementDigest: string;
};
export type VerifiedCorpusMembership = Pick<
  CorpusDeclaration,
  "schemaExport" | "sqlName" | "moduleId"
> & { verification: "matched" };

export const corpusDigest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Preserve quoted bodies as one token and remove comments. Unsupported or
// unterminated quoting cannot hide a statement from the admission check.
export const corpusSqlStatements = (source: string): string[] | null => {
  const statements: string[] = [];
  let statement = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (source.startsWith("--", index)) {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      statement += " ";
      continue;
    }
    if (source.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (depth > 0 && index < source.length) {
        if (source.startsWith("/*", index)) {
          depth++;
          index += 2;
        } else if (source.startsWith("*/", index)) {
          depth--;
          index += 2;
        } else {
          index++;
        }
      }
      if (depth !== 0) {
        return null;
      }
      statement += " ";
      continue;
    }
    if (char === "'" || char === '"') {
      const start = index++;
      // Only explicit E-strings have setting-independent backslash escapes.
      const escapes = /(?:^|[^a-zA-Z0-9_$\u0080-\u{10FFFF}])[eE]'$/u.test(
        source.slice(Math.max(0, start - 2), start + 1),
      );
      let closed = false;
      while (index < source.length) {
        if (source[index] === "\\") {
          if (!escapes) {
            return null;
          }
          index += 2;
          continue;
        }
        if (source[index++] !== char) {
          continue;
        }
        if (source[index] === char) {
          index++;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed) {
        return null;
      }
      const token = source.slice(start, index);
      if (char === '"') {
        const identifier = token.slice(1, -1);
        statement += /^[a-z_][a-z0-9_]*$/u.test(identifier)
          ? identifier
          : token;
      } else {
        statement += token;
      }
      continue;
    }
    if (char === "$") {
      const tag = /^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/u
        .exec(source.slice(index))
        ?.at(0);
      if (tag === undefined) {
        return null;
      }
      const end = source.indexOf(tag, index + tag.length);
      if (end === -1) {
        return null;
      }
      statement += source.slice(index, end + tag.length);
      index = end + tag.length;
      continue;
    }
    if (char === ";") {
      if (statement.trim()) {
        statements.push(statement.trim());
      }
      statement = "";
    } else {
      statement += char;
    }
    index++;
  }
  if (statement.trim()) {
    statements.push(statement.trim());
  }
  return statements;
};

const SIMPLE_COLUMN =
  /^[a-z_][a-z0-9_]* (?:uuid|text|varchar(?:\([0-9]+\))?|integer|smallint|bigint|numeric|date|timestamp(?: with time zone)?|jsonb?|bytea)(?: (?:NOT NULL|PRIMARY KEY|DEFAULT (?:NULL|[0-9]+|'[a-zA-Z0-9_ -]*'|CURRENT_TIMESTAMP)))*$/iu;

const isUnsupportedGlobal = (statement: string): boolean =>
  /\bALTER DEFAULT PRIVILEGES\b/iu.test(statement) ||
  /^(?:DO\b|CALL\b|EXECUTE\b|CREATE(?: OR REPLACE)? (?:FUNCTION|PROCEDURE)\b|ALTER (?:ROLE|SCHEMA)\b)/iu.test(
    statement,
  ) ||
  (/^GRANT\b/iu.test(statement) &&
    (!/\bON\b/iu.test(statement) || /\bON ALL\b/iu.test(statement))) ||
  /U&["']/iu.test(statement) ||
  /\b(?:pg_read_all_data|pg_write_all_data)\b/iu.test(statement);

const createdColumns = (
  definition: string,
  classified: CorpusDeclaration["columns"],
) => {
  const columns = definition.split(/, */u);
  const errors: string[] = [];
  const columnTypes = new Map<string, string>();
  if (!columns.every((column) => SIMPLE_COLUMN.test(column))) {
    errors.push("unsupported table definition or foreign key");
  }
  for (const column of columns) {
    const name = column.split(" ").at(0);
    const type =
      /^[a-z_][a-z0-9_]* (timestamp with time zone|[a-z]+(?:\([0-9]+\))?)/iu
        .exec(column)
        ?.at(1);
    if (name !== undefined && type !== undefined) {
      columnTypes.set(name, type.toLowerCase());
    }
  }
  const names = columns
    .map((column) => column.split(" ").at(0) ?? "")
    .toSorted();
  if (
    JSON.stringify(names) !== JSON.stringify(Object.keys(classified).toSorted())
  ) {
    errors.push("migration columns differ from classified columns");
  }
  return { errors, columnTypes: Object.fromEntries(columnTypes) };
};

export const verifyCorpusMigrations = (
  entry: CorpusDeclaration,
  migrations: readonly CorpusMigration[],
) => {
  const errors: string[] = [];
  const relevant: { file: string; statement: string }[] = [];
  const columnTypes = new Map<string, string>();
  if (!/^[a-z_][a-z0-9_]*$/u.test(entry.sqlName)) {
    return {
      errors: ["unsupported relation name"],
      relevant,
      columnTypes: Object.fromEntries(columnTypes),
    };
  }
  const relation = `public\\.${entry.sqlName}`;
  const mentions = new RegExp(`\\b${entry.sqlName}\\b`, "iu");
  let created = false;
  let enabled = false;
  let forced = false;
  let revokedApp = false;
  let revokedPublic = false;
  let policies = 0;
  for (const migration of migrations) {
    const statements = corpusSqlStatements(migration.sql);
    if (statements === null) {
      errors.push(`${migration.file}: unsupported migration quoting`);
      continue;
    }
    for (const raw of statements) {
      const statement = raw.replace(/[ \t\r\n]+/gu, " ").trim();
      // Default ACLs can affect a table created in a later migration. Dynamic
      // SQL, routines and role/schema-wide changes require separate analysis.
      if (isUnsupportedGlobal(statement)) {
        relevant.push({ file: migration.file, statement });
        errors.push(
          `${migration.file}: unsupported global or dynamic privilege statement`,
        );
        continue;
      }
      if (!mentions.test(statement)) {
        continue;
      }
      relevant.push({ file: migration.file, statement });
      const create = new RegExp(
        `^CREATE TABLE ${relation} \\((.*)\\)$`,
        "iu",
      ).exec(statement);
      if (create !== null) {
        if (created) {
          errors.push("relation is created more than once");
        }
        created = true;
        const definition = create.at(1);
        if (definition === undefined) {
          errors.push("missing column definition");
          continue;
        }
        const parsed = createdColumns(definition, entry.columns);
        errors.push(...parsed.errors);
        for (const [name, type] of Object.entries(parsed.columnTypes)) {
          columnTypes.set(name, type);
        }
        continue;
      }
      if (!created) {
        errors.push("relation is referenced before its verified creation");
        continue;
      }
      if (
        new RegExp(
          `^ALTER TABLE ${relation} ENABLE ROW LEVEL SECURITY$`,
          "iu",
        ).test(statement)
      ) {
        enabled = true;
        continue;
      }
      if (
        new RegExp(
          `^ALTER TABLE ${relation} FORCE ROW LEVEL SECURITY$`,
          "iu",
        ).test(statement)
      ) {
        forced = true;
        continue;
      }
      const revoke = new RegExp(
        `^REVOKE ALL(?: PRIVILEGES)? ON(?: TABLE)? ${relation} FROM (stella|PUBLIC)(?:, (stella|PUBLIC))?$`,
        "iu",
      ).exec(statement);
      if (revoke !== null) {
        const roles = revoke
          .slice(1)
          .filter((role) => typeof role === "string" && role !== "")
          .map((role) => role.toLowerCase());
        revokedApp ||= roles.includes("stella");
        revokedPublic ||= roles.includes("public");
        continue;
      }
      const policy = new RegExp(
        `^CREATE POLICY [a-z_][a-z0-9_]* ON ${relation}(?: AS PERMISSIVE)? FOR ALL TO PUBLIC USING \\((.+)\\) WITH CHECK \\((.+)\\)$`,
        "iu",
      ).exec(statement);
      if (
        policy?.[1] !== undefined &&
        policy[2] !== undefined &&
        isOwnerOnlyExpression(policy[1], entry.sqlName) &&
        isOwnerOnlyExpression(policy[2], entry.sqlName)
      ) {
        policies++;
        continue;
      }
      errors.push(
        `${migration.file}: unsupported statement touching admitted relation`,
      );
    }
  }
  if (
    !created ||
    !enabled ||
    !forced ||
    !revokedApp ||
    !revokedPublic ||
    policies !== 1
  ) {
    errors.push(
      "migration proof requires creation, ENABLE/FORCE RLS, both revokes and one owner-only policy",
    );
  }
  return { errors, relevant, columnTypes: Object.fromEntries(columnTypes) };
};

type VerifyBundleArgs = {
  entries: readonly CorpusDeclaration[];
  attestations: readonly CorpusAttestation[];
  schemaDigest: string;
  migrations: readonly CorpusMigration[];
};
export const verifiedCorpusMembership = ({
  entries,
  attestations,
  schemaDigest,
  migrations,
}: VerifyBundleArgs): VerifiedCorpusMembership[] => {
  const migrationDigest = corpusDigest(migrations);
  return entries.flatMap((entry) => {
    const result = verifyCorpusMigrations(entry, migrations);
    const proof = attestations.find(
      (candidate) => candidate.schemaExport === entry.schemaExport,
    );
    if (
      result.errors.length !== 0 ||
      proof === undefined ||
      proof.declarationDigest !== corpusDigest(entry) ||
      proof.schemaDigest !== schemaDigest ||
      proof.migrationDigest !== migrationDigest ||
      proof.statementDigest !== corpusDigest(result.relevant)
    ) {
      return [];
    }
    return [
      {
        schemaExport: entry.schemaExport,
        sqlName: entry.sqlName,
        moduleId: entry.moduleId,
        verification: "matched" as const,
      },
    ];
  });
};
