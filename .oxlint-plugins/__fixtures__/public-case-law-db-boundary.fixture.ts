// Passive regression fixture for public-case-law-db-boundary.

// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: private schema import crosses the public case-law boundary
import { caseLawDecisions, user } from "@/api/db/schema";

declare const tx: {
  query: {
    caseLawDecisions: { findMany: () => unknown };
    user: { findMany: () => unknown };
  };
};
declare const sql: (parts: TemplateStringsArray) => unknown;

// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: private relation query crosses the boundary
export const privateQuery = tx.query.user.findMany();
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: private table text cannot hide in a string
export const privateSqlText = "select * from user";
// oxlint-disable-next-line public-case-law-db-boundary/public-case-law-db-boundary -- fixture: private table text cannot hide in a template
export const privateSqlTemplate = sql`select * from matters`;

export const publicQuery = tx.query.caseLawDecisions.findMany();
export const publicSql = sql`select * from case_law_decisions`;
void caseLawDecisions;
void user;
