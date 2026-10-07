import { panic } from "better-result";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import * as v from "valibot";

import {
  parseReasonedLedger,
  runLedgerMembershipGuard,
} from "./ledger-membership.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const LEDGER = "scripts/sha256-migration-ledger.json";
const RULE = "no-raw-sha256";
const outputSchema = v.object({
  diagnostics: v.array(v.object({ code: v.string(), filename: v.string() })),
});

export const sha256MigrationFiles = (root: string): string[] => {
  const temporary = mkdtempSync(path.join(tmpdir(), "sha256-migration-"));
  const config = path.join(temporary, "oxlint.config.ts");
  writeFileSync(
    config,
    `export default ${JSON.stringify({
      categories: { correctness: "off" },
      jsPlugins: [path.join(root, ".oxlint-plugins/no-raw-sha256.ts")],
      rules: { [`${RULE}/${RULE}`]: "error" },
    })};\n`,
  );
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--bun",
      "oxlint",
      "-c",
      config,
      "-f",
      "json",
      "apps",
      "packages",
      "scripts",
      ".oxlint-plugins",
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  rmSync(temporary, { recursive: true, force: true });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    panic(
      `SHA-256 census failed (${result.exitCode}): ${result.stderr.toString()}`,
    );
  }
  const output = v.parse(outputSchema, JSON.parse(result.stdout.toString()));
  return [
    ...new Set(
      output.diagnostics
        .filter(({ code }) => code.startsWith(RULE))
        .map(({ filename }) =>
          path
            .relative(root, path.resolve(root, filename))
            .replaceAll("\\", "/"),
        ),
    ),
  ].toSorted();
};

export const migrationLedger = (files: readonly string[]) =>
  files.map((id) => ({ id, reason: "migrates in a follow-up" }));

export const parseOwnerLedger = (text: string, label: string): string[] => {
  const source = ts.createSourceFile(label, text, ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== "SHA256_OWNERS"
      ) {
        continue;
      }
      let value = declaration.initializer;
      while (
        value &&
        (ts.isAsExpression(value) || ts.isSatisfiesExpression(value))
      ) {
        value = value.expression;
      }
      if (!value || !ts.isObjectLiteralExpression(value)) {
        panic(`${label}: owners must be a literal reasoned map`);
      }
      return value.properties.map((property) => {
        if (
          !ts.isPropertyAssignment(property) ||
          !ts.isStringLiteral(property.name) ||
          !ts.isStringLiteral(property.initializer) ||
          property.initializer.text.trim().length === 0
        ) {
          panic(`${label}: every owner needs a literal path and reason`);
        }
        return property.name.text;
      });
    }
  }
  return panic(`${label}: SHA256_OWNERS must be declared`);
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--write")) {
    writeFileSync(
      path.join(ROOT, LEDGER),
      `${JSON.stringify(migrationLedger(sha256MigrationFiles(ROOT)), null, 2)}\n`,
    );
  } else if (!args.includes("--self-test")) {
    const actual = sha256MigrationFiles(ROOT);
    const recorded = parseReasonedLedger(
      readFileSync(path.join(ROOT, LEDGER), "utf-8"),
      LEDGER,
    ).toSorted();
    if (JSON.stringify(actual) !== JSON.stringify(recorded)) {
      const missing = actual.filter((id) => !recorded.includes(id));
      const stale = recorded.filter((id) => !actual.includes(id));
      panic(
        [
          "SHA-256 migration ledger must enumerate the current rule diagnostics; regenerate it after migrating files.",
          `missing from the ledger: ${missing.join(", ") || "none"}`,
          `no longer reported: ${stale.join(", ") || "none"}`,
        ].join("\n"),
      );
    }
  }
  const migrationStatus = runLedgerMembershipGuard({
    ledgerRel: LEDGER,
    repoRoot: ROOT,
    parseLedger: parseReasonedLedger,
    label: "SHA-256 migration",
    remediation: "route new hashing through its runtime owner",
    args: args.filter((arg) => arg !== "--write"),
  });
  const ownerStatus = runLedgerMembershipGuard({
    ledgerRel: "scripts/sha256-owners.ts",
    repoRoot: ROOT,
    parseLedger: parseOwnerLedger,
    label: "SHA-256 owners",
    remediation: "reuse a registered owner",
    args: args.filter((arg) => arg !== "--write"),
  });
  process.exitCode = Math.max(migrationStatus, ownerStatus);
}
