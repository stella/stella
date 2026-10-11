import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import {
  isCaseLawPublicReadModule,
  moduleRestrictedSchemaReads,
  moduleRestrictedSchemaReadsFromSources,
  UNREDACTED_VIEW_ALLOWED_MODULES,
} from "../public-case-law-db-boundary.ts";
import { PUBLIC_LAW_MIXED_MODULES } from "../public-law-decision-surface-modules.ts";
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

const lint = async (
  source: string,
  sourcePath = "apps/api/src/lib/read.ts",
  ruleOptions?: unknown,
) =>
  await lintSingleRule("public-case-law-db-boundary", `${source}\n`, {
    sourcePath,
    ...(ruleOptions === undefined ? {} : { ruleOptions }),
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

  test("public case-law reads allow type-only base schema imports", async () => {
    for (const declaration of [
      'import type { caseLawDecisions as decisions } from "@/api/db/schema/case-law";',
      'import { type caseLawDecisions as decisions } from "@/api/db/schema/case-law";',
    ]) {
      const source = [
        'import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";',
        declaration,
        "export type DecisionTable = typeof decisions;",
        "void caseLawPublicReadDb;",
      ].join("\n");
      expect(
        await lint(source, "apps/api/src/handlers/case-law/read.ts"),
      ).toEqual([]);
    }
  });

  test("decision-surface mode checks base reads without private relation checks", async () => {
    const options = { scope: "decision-surface" };
    const directSchema = [
      'import { caseLawDecisions as decisions } from "@/api/db/schema/case-law";',
      "void decisions;",
    ].join("\n");
    expect(
      await lint(
        directSchema,
        "apps/api/src/handlers/chat/chat-prompt.ts",
        options,
      ),
    ).toHaveLength(1);

    const rawBaseRead = [
      'import { sql } from "drizzle-orm";',
      "export const query = sql`select id from case_law_decisions`;",
    ].join("\n");
    expect(
      await lint(
        rawBaseRead,
        "apps/api/src/handlers/chat/chat-prompt.ts",
        options,
      ),
    ).toHaveLength(1);

    const rawUnredactedRead = [
      'import { sql } from "drizzle-orm";',
      "export const query = sql`select id from case_law_unredacted_decisions`;",
    ].join("\n");
    expect(
      await lint(
        rawUnredactedRead,
        "apps/api/src/handlers/chat/chat-prompt.ts",
        options,
      ),
    ).toHaveLength(1);

    const unredactedAlias = [
      'import { unredactedCaseLawDecisions as rows } from "@/api/db/schema";',
      "void rows;",
    ].join("\n");
    expect(
      await lint(
        unredactedAlias,
        "apps/api/src/handlers/chat/chat-prompt.ts",
        options,
      ),
    ).toHaveLength(1);

    const privateRelation = [
      'import { sql } from "drizzle-orm";',
      "export const query = sql`select id from users`;",
    ].join("\n");
    expect(
      await lint(
        privateRelation,
        "apps/api/src/handlers/chat/chat-prompt.ts",
        options,
      ),
    ).toEqual([]);
  });

  test("public and mixed reads import runtime schema tables by name", async () => {
    for (const modulePath of [
      "@/api/db/schema",
      path.resolve(
        import.meta.dir,
        "../__fixtures__/case-law-schema-barrel-chain.fixture.ts",
      ),
    ]) {
      for (const binding of ["* as schema", "schema"]) {
        for (const mode of ["public-law", "decision-surface"]) {
          const source = [
            'import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";',
            `import ${binding} from "${modulePath}";`,
            "void caseLawPublicReadDb;",
            "void schema;",
          ].join("\n");
          expect(
            await lint(source, "apps/api/src/handlers/chat/chat-prompt.ts", {
              scope: mode,
            }),
          ).toEqual([2]);
          expect(
            await lint(
              source
                .replace(`import ${binding}`, () => `import type ${binding}`)
                .replace("void schema;", "export type Schema = typeof schema;"),
              "apps/api/src/handlers/chat/chat-prompt.ts",
              { scope: mode },
            ),
          ).toEqual([]);
        }
      }
    }
  });

  test("decision-surface config covers each mixed public-law module", () => {
    const configPath = path.resolve(import.meta.dir, "../../oxlint.config.ts");
    const configSource = readFileSync(configPath, "utf-8");
    const config = ts.createSourceFile(
      configPath,
      configSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    let mixedModuleListReferences = 0;
    let decisionSurfaceOption = false;
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node)) {
        const name = node.name.getText(config);
        if (
          (name === "files" || name === "excludeFiles") &&
          ts.isArrayLiteralExpression(node.initializer) &&
          node.initializer.elements.some(
            (element) =>
              ts.isSpreadElement(element) &&
              ts.isIdentifier(element.expression) &&
              element.expression.text === "PUBLIC_LAW_MIXED_MODULES",
          )
        ) {
          mixedModuleListReferences += 1;
        }
        if (
          name === "scope" &&
          ts.isStringLiteral(node.initializer) &&
          node.initializer.text === "decision-surface"
        ) {
          decisionSurfaceOption = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(config);

    expect(PUBLIC_LAW_MIXED_MODULES).toHaveLength(7);
    expect(new Set(PUBLIC_LAW_MIXED_MODULES).size).toBe(
      PUBLIC_LAW_MIXED_MODULES.length,
    );
    expect(mixedModuleListReferences).toBe(2);
    expect(decisionSurfaceOption).toBe(true);
  });

  test("helper classification identifies the restricted schema bindings", () => {
    const baseDecision = new Set(["caseLawDecisions"] as const);
    const unredactedDecision = new Set(["unredactedCaseLawDecisions"] as const);
    expect(
      moduleRestrictedSchemaReads(
        ".oxlint-plugins/__fixtures__/case-law-base-helper.fixture",
      ),
    ).toEqual(baseDecision);
    expect(
      moduleRestrictedSchemaReads(
        ".oxlint-plugins/__fixtures__/case-law-namespace-helper.fixture",
      ),
    ).toEqual(new Set(["caseLawDecisions", "unredactedCaseLawDecisions"]));
    expect(
      moduleRestrictedSchemaReads(
        ".oxlint-plugins/__fixtures__/case-law-reexport-helper.fixture",
      ),
    ).toEqual(baseDecision);
    expect(
      moduleRestrictedSchemaReads(
        ".oxlint-plugins/__fixtures__/case-law-type-helper.fixture",
      ),
    ).toEqual(new Set());
    expect(
      moduleRestrictedSchemaReads(
        ".oxlint-plugins/__fixtures__/case-law-unredacted-helper.fixture",
      ),
    ).toEqual(unredactedDecision);
    expect(
      moduleRestrictedSchemaReads(
        ".oxlint-plugins/__fixtures__/case-law-unredacted-helper.fixture",
        { exportName: "helper" },
      ),
    ).toEqual(unredactedDecision);
    expect(
      moduleRestrictedSchemaReads(
        ".oxlint-plugins/__fixtures__/case-law-unredacted-reexport.fixture",
        { exportName: "decisionRows" },
      ),
    ).toEqual(unredactedDecision);

    const mixedBarrel =
      ".oxlint-plugins/__fixtures__/case-law-mixed-schema-barrel.fixture";
    expect(
      moduleRestrictedSchemaReads(mixedBarrel, {
        exportName: "subjectDecisions",
      }),
    ).toEqual(unredactedDecision);
    expect(
      moduleRestrictedSchemaReads(mixedBarrel, {
        exportName: "baseDecisions",
      }),
    ).toEqual(baseDecision);
  });

  test("cyclic helper exports retain the runtime schema classification", () => {
    const cycleModules = new Map([
      [
        "fixture/cycle-a",
        [
          'export { cycleHelper } from "./cycle-b";',
          'import { caseLawDecisions as decisionTable } from "@/api/db/schema/case-law";',
          "export const helper = decisionTable.id;",
        ].join("\n"),
      ],
      ["fixture/cycle-b", 'export { helper } from "./cycle-a";'],
    ]);
    const readSource = (dependencyId: string) => {
      const source = cycleModules.get(dependencyId);
      return source === undefined
        ? null
        : { filename: `${dependencyId}.ts`, source };
    };
    for (const moduleId of cycleModules.keys()) {
      expect(
        moduleRestrictedSchemaReadsFromSources(moduleId, {
          readSource,
        }),
      ).toEqual(new Set(["caseLawDecisions"]));
    }
    cycleModules.set(
      "fixture/cycle-a",
      [
        'export { cycleHelper } from "./cycle-b";',
        'import { unredactedCaseLawDecisions as decisionTable } from "@/api/db/schema/case-law";',
        "export const helper = decisionTable.id;",
      ].join("\n"),
    );
    for (const moduleId of cycleModules.keys()) {
      expect(
        moduleRestrictedSchemaReadsFromSources(moduleId, { readSource }),
      ).toEqual(new Set(["unredactedCaseLawDecisions"]));
    }
    cycleModules.set(
      "fixture/cycle-a",
      'export { cycleHelper } from "./cycle-b";',
    );
    for (const moduleId of cycleModules.keys()) {
      expect(
        moduleRestrictedSchemaReadsFromSources(moduleId, { readSource }),
      ).toEqual(new Set());
    }
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

  test("the subject lookup cannot import the base decision table", async () => {
    const source = [
      'import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";',
      'import { caseLawDecisions as rows } from "@/api/db/schema";',
      "void rows;",
      "void caseLawPublicReadDb;",
    ].join("\n");
    expect(
      await lint(source, "apps/api/src/lib/case-law/public-subject.ts"),
    ).toHaveLength(1);
  });

  test("the unredacted decision view is reserved for subject lookup", async () => {
    const source = [
      'import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";',
      'import { unredactedCaseLawDecisions as subjectRows } from "@/api/db/schema";',
      "void subjectRows;",
    ].join("\n");
    expect(
      await lint(source, "apps/api/src/handlers/case-law/read.ts"),
    ).toHaveLength(1);
  });

  test("subject lookup may import an unredacted binding from the schema barrel", async () => {
    const source = [
      'import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";',
      'import { unredactedCaseLawDecisions as subjectRows } from "@/api/db/schema";',
      "void caseLawPublicReadDb;",
      "void subjectRows;",
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

  test("named schema re-exports and closed-over helpers retain their allowance", async () => {
    for (const binding of [
      {
        fixture: "case-law-unredacted-reexport",
        name: "decisionRows",
        subjectAllowed: true,
      },
      {
        fixture: "case-law-unredacted-helper",
        name: "helper",
        subjectAllowed: true,
      },
      {
        fixture: "case-law-mixed-schema-barrel",
        name: "subjectDecisions",
        subjectAllowed: true,
      },
      {
        fixture: "case-law-mixed-schema-barrel",
        name: "baseDecisions",
        subjectAllowed: false,
      },
    ]) {
      const source = [
        'import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";',
        `import { ${binding.name} as rows } from ${JSON.stringify(path.resolve(import.meta.dir, `../__fixtures__/${binding.fixture}.fixture.ts`))};`,
        "void caseLawPublicReadDb;",
        "void rows;",
      ].join("\n");
      expect(
        await lint(source, "apps/api/src/handlers/case-law/read.ts"),
      ).toEqual([2]);
      expect(
        await lint(source, "apps/api/src/handlers/chat/chat-prompt.ts", {
          scope: "decision-surface",
        }),
      ).toEqual([2]);
      expect(
        await lint(source, "apps/api/src/lib/case-law/public-subject.ts"),
      ).toEqual(binding.subjectAllowed ? [] : [2]);
    }
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
