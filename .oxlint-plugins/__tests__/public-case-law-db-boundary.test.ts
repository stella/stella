import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import {
  isCaseLawPublicReadModule,
  UNREDACTED_VIEW_ALLOWED_MODULES,
} from "../public-case-law-db-boundary.ts";
import { canonicalModuleId } from "../utils.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

// The passive fixture sits inside the case-law boundary. These cases cover
// the other ways a file reads public law, which the fixture cannot also be:
// through the legislation handle, through the shared-query registry, as an
// owner module itself, and not at all.

const RELATION_SQL = [
  "declare const sql: (parts: TemplateStringsArray) => unknown;",
  "export const hits = sql`select 1 from legislation_index_jobs`;",
  "export const allowed = sql`select 1 from legislation_search_documents`;",
].join("\n");

const lint = async (source: string, sourcePath = "apps/api/src/lib/read.ts") =>
  await lintSingleRule("public-case-law-db-boundary", `${source}\n`, {
    sourcePath,
  });

describe.serial("public-law relation scan", () => {
  test("public case-law reads cannot name the base decision table", async () => {
    const source = [
      'import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";',
      'import { caseLawDecisions as decisions } from "@/api/db/schema/case-law";',
      "void decisions;",
      "void caseLawPublicReadDb;",
    ].join("\n");
    expect(
      await lint(source, "apps/api/src/handlers/case-law/read.ts"),
    ).toHaveLength(1);
  });

  test("public case-law SQL cannot name the base decision table", async () => {
    const source = [
      'import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";',
      'import { sql } from "drizzle-orm";',
      "export const query = sql`select id from case_law_decisions`;",
    ].join("\n");
    expect(
      await lint(source, "apps/api/src/handlers/case-law/read.ts"),
    ).toHaveLength(1);
  });

  test("the unredacted decision view is reserved for subject lookup", async () => {
    const source = [
      'import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";',
      'import { unredactedCaseLawDecisions } from "@/api/db/schema";',
      "void unredactedCaseLawDecisions;",
    ].join("\n");
    expect(
      await lint(source, "apps/api/src/handlers/case-law/read.ts"),
    ).toHaveLength(1);
  });

  test("subject lookup may use the unredacted decision view", async () => {
    const source = [
      'import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";',
      'import { unredactedCaseLawDecisions } from "@/api/db/schema";',
      "void caseLawPublicReadDb;",
      "void unredactedCaseLawDecisions;",
    ].join("\n");
    expect(
      await lint(source, "apps/api/src/lib/case-law/public-subject.ts"),
    ).toEqual([]);
  });

  test("the unredacted view allowance stays scoped to the subject module", () => {
    expect(UNREDACTED_VIEW_ALLOWED_MODULES).toEqual([
      "apps/api/src/lib/case-law/public-subject.ts",
    ]);
  });

  test("every production public-read module is in the rule boundary", () => {
    const repositoryRoot = path.resolve(import.meta.dir, "../..");
    const apiRoot = path.join(repositoryRoot, "apps/api/src");
    const candidateModules = new Map<string, ReadonlySet<string>>();
    for (const filename of new Bun.Glob("**/*.{ts,tsx}").scanSync({
      cwd: apiRoot,
      onlyFiles: true,
    })) {
      if (
        filename.endsWith(".d.ts") ||
        filename.endsWith(".test.ts") ||
        filename.endsWith(".test.tsx") ||
        filename.includes("/tests/")
      ) {
        continue;
      }
      const sourcePath = `apps/api/src/${filename}`;
      const sourceFile = ts.createSourceFile(
        sourcePath,
        readFileSync(path.join(apiRoot, filename), "utf-8"),
        ts.ScriptTarget.Latest,
        true,
        filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const importedModules = new Set<string>();
      let importsReadSurface = false;
      for (const statement of sourceFile.statements) {
        const moduleSpecifier =
          ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
            ? statement.moduleSpecifier
            : undefined;
        if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) {
          continue;
        }
        const moduleId = canonicalModuleId(moduleSpecifier.text, sourcePath);
        importedModules.add(moduleId);
        const namedBindings =
          ts.isImportDeclaration(statement) && statement.importClause
            ? statement.importClause.namedBindings
            : undefined;
        if (!namedBindings || !ts.isNamedImports(namedBindings)) {
          continue;
        }
        const importedNames = new Set(
          namedBindings.elements.map(
            ({ propertyName, name }) => propertyName?.text ?? name.text,
          ),
        );
        if (
          moduleId === "apps/api/src/lib/case-law-public-read-db" &&
          (importedNames.has("CaseLawPublicReadDb") ||
            importedNames.has("CaseLawPublicReadTransaction"))
        ) {
          importsReadSurface = true;
        }
        if (
          moduleId === "apps/api/src/lib/public-law-shared-query" &&
          (importedNames.has("definePublicLawSharedQuery") ||
            importedNames.has("PUBLIC_LAW_SHARED_QUERY"))
        ) {
          importsReadSurface = true;
        }
      }
      if (importsReadSurface) {
        candidateModules.set(sourcePath, importedModules);
      }
    }
    candidateModules.set(
      "apps/api/src/lib/public-law-shared-query.ts",
      new Set(),
    );

    expect(candidateModules.size).toBeGreaterThan(1);
    for (const [filename, importedModules] of candidateModules) {
      expect(isCaseLawPublicReadModule(filename, importedModules)).toBe(true);
    }
  });

  test("CaseLawPublicReadDb, its transaction, and registered query modules reject raw base reads", async () => {
    const caseLawReadTypeSource = (typeName: string) =>
      [
        `import type { ${typeName} } from "@/api/lib/case-law-public-read-db";`,
        'import { sql } from "drizzle-orm";',
        `declare const readHandle: ${typeName};`,
        "void readHandle;",
        "export const query = sql`select id from case_law_decisions`;",
      ].join("\n");
    for (const typeName of [
      "CaseLawPublicReadDb",
      "CaseLawPublicReadTransaction",
    ]) {
      expect(
        await lint(
          caseLawReadTypeSource(typeName),
          `apps/api/src/handlers/case-law/${typeName}.ts`,
        ),
      ).toHaveLength(1);
    }
    const registeredQuery = [
      'import { definePublicLawSharedQuery, PUBLIC_LAW_SHARED_QUERY } from "@/api/lib/public-law-shared-query";',
      'import { sql } from "drizzle-orm";',
      "export const query = definePublicLawSharedQuery(",
      "  PUBLIC_LAW_SHARED_QUERY.caseLawAnalysis,",
      "  async () => await sql`select id from case_law_decisions`,",
      ");",
    ].join("\n");
    expect(
      await lint(
        registeredQuery,
        "apps/api/src/handlers/case-law/registered-query.ts",
      ),
    ).toHaveLength(1);
    const sharedQueryRegistry = [
      'import { sql } from "drizzle-orm";',
      "export const query = sql`select id from case_law_decisions`;",
    ].join("\n");
    expect(
      await lint(
        sharedQueryRegistry,
        "apps/api/src/lib/public-law-shared-query.ts",
      ),
    ).toHaveLength(1);
  });

  test("covers a legislation read", async () => {
    const source = [
      'import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";',
      "export type Handle = LegislationReadDb;",
      RELATION_SQL,
    ].join("\n");

    expect(await lint(source)).toEqual([4]);
  });

  test("covers a module that registers a shared query", async () => {
    const source = [
      'import { PUBLIC_LAW_SHARED_QUERY } from "@/api/lib/public-law-shared-query";',
      "export const key = PUBLIC_LAW_SHARED_QUERY;",
      RELATION_SQL,
    ].join("\n");

    expect(await lint(source)).toEqual([4]);
  });

  test("covers the connection module itself", async () => {
    expect(
      await lint(RELATION_SQL, "apps/api/src/lib/public-law-read-db.ts"),
    ).toEqual([2]);
  });

  test("leaves a file that reads no public law alone", async () => {
    expect(await lint(RELATION_SQL)).toEqual([]);
  });

  test("keeps the case-law import and text checks to case-law reads", async () => {
    const source = [
      'import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";',
      'import { legislationTitleFold } from "@/api/db/schema";',
      "export type Handle = LegislationReadDb;",
      'export const audience = "workspace";',
      "void legislationTitleFold;",
    ].join("\n");

    expect(await lint(source)).toEqual([]);
  });
});
