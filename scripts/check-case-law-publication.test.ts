import { expect, test } from "bun:test";

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
        export const publicCaseLawDecisionWhere = sql\`\${sql.raw(eligibleSql("d"))}\`;`,
    },
    {
      file: "apps/api/src/lib/legal-search/provider.ts",
      source: `import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
        import { publicCaseLawDecisionWhere } from "@/api/lib/case-law/search-sql";
        declare const db: CaseLawPublicReadDb;
        const query = sql\`SELECT d.id FROM case_law_decisions d WHERE \${publicCaseLawDecisionWhere}\`;`,
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

test("each joined decision table needs its own publication condition", () => {
  const inspect = (condition: string) =>
    inspectCaseLawPublication([
      {
        file: "apps/api/src/lib/legal-search/joined-decisions.ts",
        source: `${publicationImports}
        import { and, eq } from "drizzle-orm";
        import { alias } from "drizzle-orm/pg-core";
        const joinedDecision = alias(caseLawDecisions, "joined_decision");
        const query = db.select().from(caseLawDecisions)
          .innerJoin(joinedDecision, eq(joinedDecision.id, caseLawDecisions.id))
          .where(${condition});`,
      },
    ]);
  const single = inspect("eligible(caseLawDecisions)");
  expect(single.reads).toHaveLength(2);
  expect(single.errors).toHaveLength(1);
  const both = inspect(
    "and(eligible(caseLawDecisions), eligible(joinedDecision))",
  );
  expect(both.reads).toHaveLength(2);
  expect(both.errors).toEqual([]);
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

test("each raw decision table has its own alias", () => {
  const inspect = (aliases: readonly string[]) =>
    inspectCaseLawPublication([
      {
        file: "apps/api/src/lib/legal-search/decision-aliases.ts",
        source: `import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
        import { sql } from "drizzle-orm";
        import { publishedCaseLawDecisionSqlFor as eligible } from "@/api/lib/case-law/published-decisions";
        declare const db: CaseLawPublicReadDb;
        const query = db.execute(sql\`${aliases.map((alias) => `SELECT ${alias}.id FROM case_law_decisions ${alias} WHERE \${sql.raw(eligible("${alias}"))}`).join(" UNION ALL ")}\`);`,
      },
    ]);
  const repeated = inspect(["d", "d"]);
  expect(repeated.errors).toHaveLength(1);
  expect(repeated.errors.at(0)).toContain(
    "give each decision table its own alias",
  );
  expect(inspect(["d1", "d2"]).errors).toEqual([]);
});

test("the publication predicate is checked as a top-level condition", () => {
  const report = inspectCaseLawPublication([
    {
      file: "apps/api/src/lib/legal-search/publication-condition.ts",
      source: `${publicationImports}
        import { and, eq, or, sql } from "drizzle-orm";
        const first = db.select().from(caseLawDecisions).where(and(eligible(caseLawDecisions), eq(caseLawDecisions.id, id)));
        const second = db.select().from(caseLawDecisions).where(or(eligible(caseLawDecisions), sql\`TRUE\`));
      `,
    },
  ]);
  expect(report.reads).toHaveLength(2);
  expect(report.errors).toHaveLength(1);
});

test("a joined source condition does not certify the base decision", () => {
  const inspect = (where: boolean) =>
    inspectCaseLawPublication([
      {
        file: "apps/api/src/lib/legal-search/join-conditions.ts",
        source: `${publicationImports}
      import { sql, eq } from "drizzle-orm";
      import { publishedCaseLawDecisionSqlFor as eligibleSql } from "@/api/lib/case-law/published-decisions";
      const raw = sql\`SELECT d.id FROM case_law_decisions d
        LEFT JOIN case_law_sources s ON s.id = d.source_id
        ${where ? "WHERE" : "AND"} \${sql.raw(eligibleSql("d"))}\`;
      const builder = db.select().from(caseLawDecisions)
        .leftJoin(caseLawSources, ${where ? "eq(caseLawSources.id, caseLawDecisions.sourceId)" : "eligible(caseLawDecisions)"})
        ${where ? ".where(eligible(caseLawDecisions))" : ""};`,
      },
    ]);
  const joined = inspect(false);
  expect(joined.reads).toHaveLength(2);
  expect(joined.errors).toHaveLength(2);
  const filtered = inspect(true);
  expect(filtered.reads).toHaveLength(2);
  expect(filtered.errors).toEqual([]);
});

test("decision reads use inner or left joins", () => {
  const report = inspectCaseLawPublication([
    {
      file: "apps/api/src/lib/legal-search/decision-join.ts",
      source: `${publicationImports}
      import { sql } from "drizzle-orm";
      import { publishedCaseLawDecisionSqlFor as eligibleSql } from "@/api/lib/case-law/published-decisions";
      const query = sql\`SELECT d.id FROM case_law_sources s
        RIGHT JOIN case_law_decisions d ON s.id = d.source_id
        AND \${sql.raw(eligibleSql("d"))}\`;`,
    },
  ]);
  expect(report.reads).toHaveLength(1);
  expect(report.errors).toHaveLength(1);
  expect(report.errors.at(0)).toContain(
    "decision reads use inner or left joins",
  );
});
