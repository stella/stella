// Passive regression fixture for public-case-law-db-boundary. Importing the
// public read connection puts this file inside the boundary.

import {
  // expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
  caseLawDecisions,
  // oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: private schema import crosses the public case-law boundary
  caseLawMatterLinks,
  // Constant and type-only schema imports name no table.
  // expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
  SOURCE_TOTAL_ORIGIN,
  // expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
  type SourceTotalOrigin,
} from "@/api/db/schema";
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: namespace imports make the schema boundary unresolved
import * as caseLawSchema from "@/api/db/schema";
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
import { publishedCaseLawDecisionSqlFor } from "@/api/lib/case-law/published-decisions";

declare const tx: {
  execute: (query: unknown) => unknown;
  query: {
    caseLawDecisions: { findMany: () => unknown };
    caseLawMatterLinks: { findMany: () => unknown };
  };
};
declare const sql: ((
  parts: TemplateStringsArray,
  ...values: unknown[]
) => unknown) & { raw: (text: string) => unknown };
declare const getRelationName: () => keyof typeof tx.query;
declare const relationFragment: unknown;
declare const dynamicSql: string;
declare const LIMITS: { pageSize: number };

// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: private relation query crosses the boundary
export const privateQuery = tx.query.caseLawMatterLinks.findMany();
// oxlint-disable-next-line typescript/dot-notation, public-case-law-db-boundary/public-case-law-db-boundary -- fixture: computed query access must not cross the boundary
export const computedPrivateQuery = tx["query"].caseLawMatterLinks.findMany();
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: dynamic relation access makes the query boundary unresolved
export const dynamicQuery = tx.query[getRelationName()].findMany();
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: private table text cannot hide in a string
export const privateSqlText = "select * from user";
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- x2: fixture: private table text cannot hide in a template, and the table is no mapped relation
export const privateSqlTemplate = sql`select * from matters`;

// Relations a public-law read names must be in the relation map.
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: an unmapped relation after FROM
export const unmapped = sql`select id from case_law_ingestion_events`;
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: an unmapped relation after JOIN
export const unmappedJoin = sql`select 1 from case_law_decisions d join case_law_ingestion_events e on true`;
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: quoting does not hide a relation
export const unmappedQuoted = sql`select 1 from "case_law_ingestion_events"`;
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: nor does its schema
export const unmappedQualified = sql`select 1 from public.case_law_ingestion_events`;
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: nor a quoted schema
export const unmappedQuotedQualified = sql`select 1 from "public"."case_law_ingestion_events"`;
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: a mapped name in another schema is another relation
export const otherSchema = sql`select 1 from archive.case_law_decisions`;
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: sql.raw strings are SQL text too
export const unmappedRaw = sql.raw("select 1 from case_law_ingestion_events");
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: and so are sql.raw templates
export const rawTpl = sql.raw(`select 1 from case_law_ingestion_events`);
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: a computed relation is uninspectable
export const dynamicRelation = sql`select 1 from ${getRelationName()}`;
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: so is a value the file does not write as SQL
export const opaqueRelation = sql`select 1 from case_law_decisions d join ${relationFragment} x on true`;
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: a private schema table interpolated after FROM
export const privateTableRelation = sql`select 1 from ${caseLawMatterLinks}`;

// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
export const publicQuery = tx.query.caseLawDecisions.findMany();
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
export const publicSql = sql`select * from case_law_decisions`;
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
export const publicQuoted = sql`select 1 from "case_law_decisions"`;
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
export const publicQualified = sql`select 1 from public.case_law_sources s`;
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
export const publicTable = sql`select 1 from ${caseLawDecisions} d`;
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
export const cte = sql`with recent as (select 1) select * from recent`;
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
export const cteColumns = sql`with seen(id) as (select 1) select id from seen`;
// A CTE another template of the same file defines.
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
export const cteBody = sql`matched as (select 1)`;
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
export const cteUse = sql`with ${cteBody} select * from matched`;
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
export const lateral = sql`select 1 from case_law_decisions d join lateral (select 1) x on true`;
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
export const setReturning = sql`select 1 from jsonb_array_elements('[]') e(value)`;
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
export const extracted = sql`select extract(year from d.decision_date) from case_law_decisions d`;
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
export const distinctFrom = sql`select 1 where 1 is distinct from 2`;
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
export const catalog = sql`select 1 from pg_class join information_schema.tables t on true`;
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
export const quotedText = sql`select 'copied from elsewhere' -- read from elsewhere`;
// A fragment this file writes is read where it is written.
const lateralFragment = sql`lateral (select 1 from case_law_citations)`;
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
export const localFragment = sql`select 1 from case_law_decisions d join ${lateralFragment} x on true`;
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
export const rawFragment = sql`select 1 from ${sql.raw("case_law_sources")}`;

// A fragment is read where the statement puts it, raw names included.
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: a raw relation name in a local fragment
const rawRelation = sql.raw("legislation_index_jobs");
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
export const viaRawRelation = sql`select * from ${rawRelation}`;
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: an inline raw relation name
export const inlineRaw = sql`select 1 from ${sql.raw("legislation_index_jobs")}`;
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
const MAPPED_RELATION = "case_law_sources";
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
export const viaConstant = sql`select 1 from ${sql.raw(MAPPED_RELATION)}`;
// A parameter typed as a literal union is every relation it can name.
export const unionRelation = (
  relation: "case_law_decisions" | "legislation_index_jobs",
) =>
  // oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: one alternative is not a mapped relation
  sql`select 1 from ${sql.raw(relation)}`;
export const mappedUnion = (
  relation: "case_law_decisions" | "case_law_sources",
) =>
  // expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
  sql`select 1 from ${sql.raw(relation)}`;

// Raw text the rule cannot read is opaque executed SQL.
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: a raw string of unknown content
export const opaqueRaw = sql.raw(dynamicSql);
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: concatenation with an unknown value
export const concatenated = sql.raw("select 1 where id = " + dynamicSql); // oxlint-disable-line prefer-template -- fixture: the concatenation is the case
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: an executed template string
export const executedTemplate = tx.execute(`select ${dynamicSql}`);
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: an executed string names its relations too
export const runs = tx.execute("select 1 from legislation_index_jobs");
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
export const executedMapped = tx.execute("select 1 from case_law_decisions");
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
export const constantRaw = sql.raw(String(LIMITS.pageSize));
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
export const reviewedProducer = sql.raw(publishedCaseLawDecisionSqlFor("d"));

// Ordinary syntax does not hide a relation.
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: the second table of a comma join
export const commaJoin = sql`select 1 from case_law_decisions, legislation_index_jobs`;
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
export const mappedComma = sql`select 1 from case_law_decisions d, case_law_sources s`;
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: a comment marker inside a string
export const dashesInString = sql`select '--' as m from legislation_index_jobs`;
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: a keyword inside a quoted identifier
export const quotedKeyword = sql`select "from" from legislation_index_jobs`;
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: a dollar quote
export const dollarQuoted = sql`select $$ from x $$ from legislation_index_jobs`;
// A CTE shadows a table only in the statement that defines it.
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
export const ownCte = sql`with legislation_index_jobs as (select 1) select * from legislation_index_jobs`;
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: a CTE of another statement does not cover this one
export const otherStatement = sql`select * from legislation_index_jobs`;
// A literal type is not SQL text.
// expect-clean: public-case-law-db-boundary/public-case-law-db-boundary
export type OrganizationKind = "organization";

export type Fixture = [CaseLawPublicReadDb, SourceTotalOrigin];
void caseLawDecisions;
void caseLawMatterLinks;
void caseLawSchema;
void SOURCE_TOTAL_ORIGIN;
