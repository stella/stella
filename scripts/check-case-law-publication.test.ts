import { expect, test } from "bun:test";
import * as fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  checkExceptionHistory,
  inspectCaseLawPublication,
  publicationExceptionGrowth,
  SELECT_VISIBILITY_PROJECTIONS,
  trackedApiSources,
} from "./check-case-law-publication";

test("the tracked public case-law reads all use the publication policy", () => {
  checkExceptionHistory();
  expect(inspectCaseLawPublication(trackedApiSources()).errors).toEqual([]);
}, 60_000);

test("visibility projection exceptions have reasons", () => {
  for (const exception of SELECT_VISIBILITY_PROJECTIONS.values()) {
    expect(exception.reason.length).toBeGreaterThan(0);
  }
});

const publicationImports = `
  import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
  import { caseLawDecisions } from "@/api/db/schema";
  import { publishedCaseLawDecisionFor as eligible } from "@/api/lib/case-law/published-decisions";
  declare const db: CaseLawPublicReadDb;
`;

test("the census checks every public decision read operation", () => {
  const report = inspectCaseLawPublication([
    {
      file: "apps/api/src/handlers/case-law/provisions/list-for-decision.ts",
      source: `${publicationImports}
        const visible = db.select().from(caseLawDecisions).where(eligible(caseLawDecisions));
        const unfiltered = db.select().from(caseLawDecisions).where(eq(caseLawDecisions.id, id));
      `,
    },
  ]);
  expect(report.reads).toHaveLength(2);
  expect(report.errors).toHaveLength(1);
  expect(report.errors.at(0)).toMatch(
    /provisions\/list-for-decision\.ts:\d+: decision read/u,
  );
});

test("aliased owner imports and mixed read-write modules are inspected", () => {
  const report = inspectCaseLawPublication([
    {
      file: "apps/api/src/lib/legal-search/document-context.ts",
      source: `${publicationImports}
        const row = db.select().from(caseLawDecisions).where(eligible(caseLawDecisions));
        await db.update(caseLawDecisions).set({ metadata: nextMetadata });
        const secondRead = db.select().from(caseLawDecisions).where(eq(caseLawDecisions.id, id));
      `,
    },
  ]);
  expect(report.reads).toHaveLength(2);
  expect(report.errors).toHaveLength(1);
});

test("publication fragments resolve through their loaded source module", () => {
  const report = inspectCaseLawPublication([
    {
      file: "apps/api/src/lib/case-law/search-sql.ts",
      source: `import { sql } from "drizzle-orm";
        import { publishedCaseLawDecisionSqlFor as eligibleSql } from "@/api/lib/case-law/published-decisions";
        export const publicCaseLawDecisionJoin = sql\`JOIN case_law_sources ON \${sql.raw(eligibleSql("d"))}\`;`,
    },
    {
      file: "apps/api/src/lib/legal-search/provider.ts",
      source: `import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
        import { publicCaseLawDecisionJoin } from "@/api/lib/case-law/search-sql";
        declare const db: CaseLawPublicReadDb;
        const query = sql\`SELECT d.id FROM case_law_decisions d \${publicCaseLawDecisionJoin}\`;`,
    },
  ]);
  expect(report.errors).toEqual([]);
});

test("a branded subject parameter does not cover a broad table read", () => {
  const report = inspectCaseLawPublication([
    {
      file: "apps/api/src/handlers/case-law/decisions/get.ts",
      source: `import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
        import type { RedistributableDecisionSubject as Subject } from "@/api/lib/case-law/public-subject";
        import { caseLawDecisions } from "@/api/db/schema";
        declare const db: CaseLawPublicReadDb;
        const read = (subject: Subject) => db.select().from(caseLawDecisions).where(eq(caseLawDecisions.id, subject.id));`,
    },
  ]);
  expect(report.errors).toHaveLength(1);
});

test("a subject helper gate does not cover a broad table read", () => {
  const report = inspectCaseLawPublication([
    {
      file: "apps/api/src/handlers/case-law/decisions/citation-passages.ts",
      source: `import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
        import { withRedistributableSubject as gate } from "@/api/lib/case-law/public-subject";
        import { caseLawDecisions } from "@/api/db/schema";
        declare const db: CaseLawPublicReadDb;
        const read = () => gate(db, id, async () => db.select().from(caseLawDecisions));`,
    },
  ]);
  expect(report.errors).toHaveLength(1);
});

test("joined and imported schema aliases are counted as decision reads", () => {
  const report = inspectCaseLawPublication([
    {
      file: "apps/api/src/lib/legal-search/joins.ts",
      source: `import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
        import { caseLawDecisions as decisions } from "@/api/db/schema";
        import { publishedCaseLawDecision as publication } from "@/api/lib/case-law/published-decisions";
        declare const db: CaseLawPublicReadDb;
        const query = db.select().from(caseLawSources).innerJoin(decisions, eq(decisions.sourceId, caseLawSources.id)).where(publication);`,
    },
  ]);
  expect(report.reads).toHaveLength(1);
  expect(report.errors).toEqual([]);
});

test("a publication projection in SELECT does not certify a decision read", () => {
  const report = inspectCaseLawPublication([
    {
      file: "apps/api/src/lib/legal-search/select-only.ts",
      source: `${publicationImports}
        const query = db.select({ eligible: eligible(caseLawDecisions) }).from(caseLawDecisions).where(eq(caseLawDecisions.id, id));`,
    },
  ]);
  expect(report.errors).toHaveLength(1);
});

test("object and conditional wrapper exports do not prove a SQL predicate", () => {
  const report = inspectCaseLawPublication([
    {
      file: "apps/api/src/lib/case-law/search-sql.ts",
      source: `import { publishedCaseLawDecision as condition } from "@/api/lib/case-law/published-decisions";
        export const objectWrapper = { condition };
        export const conditionalWrapper = enabled ? condition : sql\`TRUE\`;`,
    },
    {
      file: "apps/api/src/lib/legal-search/wrapped-query.ts",
      source: `import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
        import { caseLawDecisions } from "@/api/db/schema";
        import { objectWrapper, conditionalWrapper } from "@/api/lib/case-law/search-sql";
        declare const db: CaseLawPublicReadDb;
        const query = db.select().from(caseLawDecisions).where(objectWrapper.condition);
        const second = db.select().from(caseLawDecisions).where(conditionalWrapper);`,
    },
  ]);
  expect(report.errors).toHaveLength(2);
});

test("every raw decision alias needs its own publication predicate", () => {
  const report = inspectCaseLawPublication([
    {
      file: "apps/api/src/lib/legal-search/two-decisions.ts",
      source: `import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
        import { publishedCaseLawDecisionSqlFor } from "@/api/lib/case-law/published-decisions";
        declare const db: CaseLawPublicReadDb;
        const query = db.execute(sql\`SELECT d.id FROM case_law_decisions d JOIN case_law_decisions sibling ON sibling.id = d.id WHERE \${sql.raw(publishedCaseLawDecisionSqlFor("d"))}\`);`,
    },
  ]);
  expect(report.errors).toHaveLength(1);
});

test("the publication exception budget can only shrink", () => {
  const before = `const SELECT_VISIBILITY_PROJECTIONS = new Map([["apps/api/src/a.ts", {properties: new Set(["visible"]), reason: "Bounded visibility projection"}]]);`;
  const smaller = `const SELECT_VISIBILITY_PROJECTIONS = new Map([]);`;
  const larger = before.replace('"visible"', '"visible", "content"');
  expect(publicationExceptionGrowth(smaller, before)).toEqual([]);
  expect(publicationExceptionGrowth(larger, before)).toEqual([
    "SELECT_VISIBILITY_PROJECTIONS:apps/api/src/a.ts:content",
  ]);
});

test("alternative predicates cannot replace the publication condition", () => {
  const report = inspectCaseLawPublication([
    {
      file: "apps/api/src/handlers/case-law/decisions/alternative.ts",
      source: `${publicationImports}
    const first = db.select().from(caseLawDecisions).where(or(eligible(caseLawDecisions), sql\`TRUE\`));
    const condition = enabled ? eligible(caseLawDecisions) : sql\`TRUE\`;
    const second = db.select().from(caseLawDecisions).where(condition);`,
    },
  ]);
  expect(report.errors).toHaveLength(2);
});

test("the publication predicate must be a top-level conjunct", () => {
  const report = inspectCaseLawPublication([
    {
      file: "apps/api/src/lib/legal-search/publication-conjuncts.ts",
      source: `${publicationImports}
        import { and, eq, not, or, sql } from "drizzle-orm";
        import { and as allOf, eq as equals } from "drizzle-orm";
        const owner = eligible(caseLawDecisions);
        const unsafeOrTemplate = db.select().from(caseLawDecisions).where(sql\`\${owner} OR TRUE\`);
        const equality = db.select().from(caseLawDecisions).where(eq(owner, false));
        const negation = db.select().from(caseLawDecisions).where(not(owner));
        const alternative = db.select().from(caseLawDecisions).where(or(owner, eq(caseLawDecisions.id, id)));
        const caseExpression = db.select().from(caseLawDecisions).where(sql\`CASE WHEN \${owner} THEN TRUE ELSE TRUE END\`);
        const nestedAlternative = db.select().from(caseLawDecisions).where(and(or(owner, eq(caseLawDecisions.id, id))));
        const unknownWrapper = db.select().from(caseLawDecisions).where(publicationWrapper(owner));
        const acceptedAnd = db.select().from(caseLawDecisions).where(and(owner, eq(caseLawDecisions.id, id)));
        const acceptedAliasedAnd = db.select().from(caseLawDecisions).where(allOf(owner, equals(caseLawDecisions.id, id)));
        const acceptedTemplate = db.select().from(caseLawDecisions).where(sql\`\${owner} AND \${eq(caseLawDecisions.id, id)}\`);
      `,
    },
    {
      file: "apps/api/src/lib/legal-search/publication-raw-query.ts",
      source: `import { and, eq, sql } from "drizzle-orm";
        import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
        import { publishedCaseLawDecisionSqlFor as eligibleSql } from "@/api/lib/case-law/published-decisions";
        declare const db: CaseLawPublicReadDb;
        const rawFalse = db.execute(sql\`SELECT d.id FROM case_law_decisions d WHERE \${sql.raw(eligibleSql("d"))} = FALSE\`);
        const caseOr = db.execute(sql\`SELECT d.id FROM case_law_decisions d WHERE CASE WHEN \${sql.raw(eligibleSql("d"))} THEN TRUE ELSE TRUE END OR TRUE\`);
        const aliasComparison = db.execute(sql\`SELECT d.id FROM case_law_decisions d JOIN case_law_decisions sibling ON sibling.id = d.id WHERE \${and(sql.raw(eligibleSql("d")), eq(sql.raw(eligibleSql("sibling")), false))}\`);`,
    },
  ]);
  expect(report.reads).toHaveLength(13);
  expect(report.errors).toHaveLength(10);
});

test("an arrow raw-predicate callback cannot invert the owner condition", () => {
  const report = inspectCaseLawPublication([
    {
      file: "apps/api/src/lib/legal-search/publication-raw-callback.ts",
      source: `import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
        import { sql } from "drizzle-orm";
        import { publishedCaseLawDecisionSqlFor as eligibleSql } from "@/api/lib/case-law/published-decisions";
        declare const db: CaseLawPublicReadDb;
        const predicate = (alias: string) => sql.raw(eligibleSql(alias));
        const query = () => db.execute(sql\`SELECT d.id FROM case_law_decisions d WHERE NOT (\${predicate("d")})\`);`,
    },
  ]);
  expect(report.reads).toHaveLength(1);
  expect(report.errors).toHaveLength(1);
});

const WRAPPER_KINDS = [
  "and",
  "eq_false",
  "not",
  "or_true",
  "case_or_sql",
  "unknown_wrapper",
] as const;

test("generated wrapper trees keep the publication owner out of the top-level conjunction", () => {
  assertProperty(
    "case-law-publication-rejects-generated-wrapper-trees",
    fc.property(
      fc.tuple(
        fc.constantFrom(
          "eq_false",
          "not",
          "or_true",
          "case_or_sql",
          "unknown_wrapper",
        ),
        fc.array(fc.constantFrom(...WRAPPER_KINDS), { maxLength: 8 }),
      ),
      ([unsafeRoot, nestedWrappers]) => {
        let predicate = "eligible(caseLawDecisions)";
        const wrap = (kind: (typeof WRAPPER_KINDS)[number], inner: string) => {
          switch (kind) {
            case "and":
              return `and(${inner}, eq(caseLawDecisions.id, id))`;
            case "eq_false":
              return `eq(${inner}, false)`;
            case "not":
              return `not(${inner})`;
            case "or_true":
              return `or(${inner}, sql\`TRUE\`)`;
            case "case_or_sql":
              return `sql\`CASE WHEN \${${inner}} THEN TRUE ELSE TRUE END OR TRUE\``;
            case "unknown_wrapper":
              return `publicationWrapper(${inner})`;
            default:
              kind satisfies never;
              return kind;
          }
        };
        predicate = wrap(unsafeRoot, predicate);
        for (const wrapper of nestedWrappers) {
          predicate = wrap(wrapper, predicate);
        }
        const report = inspectCaseLawPublication([
          {
            file: "apps/api/src/lib/legal-search/generated-publication-wrapper.ts",
            source: `${publicationImports}
              import { and, eq, not, or, sql } from "drizzle-orm";
              const query = db.select().from(caseLawDecisions).where(${predicate});
            `,
          },
        ]);
        expect(report.reads).toHaveLength(1);
        expect(report.errors).toHaveLength(1);
      },
    ),
  );
});
