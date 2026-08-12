// Passive regression fixture for public-case-law-db-boundary.

// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: private schema import crosses the public case-law boundary
import { caseLawDecisions, caseLawMatterLinks } from "@/api/db/schema";
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: namespace imports make the schema boundary unresolved
import * as caseLawSchema from "@/api/db/schema";

declare const tx: {
  query: {
    caseLawDecisions: { findMany: () => unknown };
    caseLawMatterLinks: { findMany: () => unknown };
  };
};
declare const sql: (parts: TemplateStringsArray) => unknown;
declare const getRelationName: () => keyof typeof tx.query;

// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: private relation query crosses the boundary
export const privateQuery = tx.query.caseLawMatterLinks.findMany();
// oxlint-disable-next-line typescript/dot-notation, public-case-law-db-boundary/public-case-law-db-boundary -- fixture: computed query access must not bypass the boundary
export const computedPrivateQuery = tx["query"].caseLawMatterLinks.findMany();
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: dynamic relation access makes the query boundary unresolved
export const dynamicQuery = tx.query[getRelationName()].findMany();
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: private table text cannot hide in a string
export const privateSqlText = "select * from user";
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: private table text cannot hide in a template
export const privateSqlTemplate = sql`select * from matters`;

export const publicQuery = tx.query.caseLawDecisions.findMany();
export const publicSql = sql`select * from case_law_decisions`;
void caseLawDecisions;
void caseLawMatterLinks;
void caseLawSchema;
