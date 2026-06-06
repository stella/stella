import { sql } from "drizzle-orm";

import { caseLawDecisions } from "@/api/db/schema";

const CASE_LAW_LANGUAGE_SEGMENT_PATTERN = "^[a-z]{2,3}(-[a-z0-9]{2,8})*$";

const normalizedCaseLawLanguageSql = sql<string>`replace(lower(${caseLawDecisions.language}), '_', '-')`;

export const validCaseLawLanguageAlternateCountSql = sql<number>`(
  count(distinct ${normalizedCaseLawLanguageSql})
    filter (where ${normalizedCaseLawLanguageSql} ~ ${CASE_LAW_LANGUAGE_SEGMENT_PATTERN})
)::int`;
