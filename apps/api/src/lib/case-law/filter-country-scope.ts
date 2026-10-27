import { panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";

import {
  CASE_LAW_SCOPED_FILTER_FIELDS,
  type CaseLawScopedFilters,
  normalizeCaseLawCountryFilters,
} from "@stll/api-contract/case-law-filter-scope";
import { PUBLIC_CASE_LAW_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";

import { caseLawSources, publishedCaseLawDecisions } from "@/api/db/schema";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";

type CaseLawFilterMembershipQueryOptions = {
  tx: CaseLawPublicReadTransaction;
  field: Exclude<(typeof CASE_LAW_SCOPED_FILTER_FIELDS)[number], "type">;
  value: string;
  country: string;
};

/** Point membership probes use existing country/court, language and source keys. */
export const caseLawFilterMembershipQuery = ({
  tx,
  field,
  value,
  country,
}: CaseLawFilterMembershipQueryOptions) => {
  const conditions = {
    court: eq(publishedCaseLawDecisions.court, value),
    lang: eq(publishedCaseLawDecisions.language, value),
    sourceId: sql`${publishedCaseLawDecisions.sourceId} = ${value}::uuid`,
  };
  return tx
    .select({
      field: sql<typeof field>`${field}::text`.as("facet_key"),
      value: sql<string>`${value}::text`.as("value"),
      country: sql<string>`${country}::text`.as("country"),
    })
    .from(publishedCaseLawDecisions)
    .innerJoin(
      caseLawSources,
      eq(caseLawSources.id, publishedCaseLawDecisions.sourceId),
    )
    .where(
      and(
        eq(publishedCaseLawDecisions.country, country),
        conditions[field],
        redistributableCaseLawSource,
      ),
    )
    .limit(1);
};

type ReadCaseLawFilterScopeOptions = {
  country: string;
  filters: CaseLawScopedFilters;
  caseLawDb: CaseLawPublicReadDb;
  courts?: readonly string[];
};

/** Each facet is checked independently: an empty intersection does not invalidate it. */
export const readCaseLawFilterScope = async ({
  country,
  filters,
  caseLawDb,
  courts = [],
}: ReadCaseLawFilterScopeOptions) => {
  const countriesByField: Record<
    (typeof CASE_LAW_SCOPED_FILTER_FIELDS)[number],
    string[]
  > = {
    court: [],
    lang: [],
    type: [],
    sourceId: [],
  };
  // There is no bounded type vocabulary yet. Its boundary schema validates
  // syntax; corpus membership awaits post-promote online index work.
  if (filters.type !== undefined) {
    countriesByField.type.push(country);
  }
  const fields = CASE_LAW_SCOPED_FILTER_FIELDS.filter(
    (field) => field !== "type",
  ).filter((field) => filters[field] !== undefined);
  if (fields.length === 0 && courts.length === 0) {
    return normalizeCaseLawCountryFilters({
      country,
      filters,
      countriesByField,
    });
  }
  const requested = [
    ...fields.flatMap((field) => {
      const value = filters[field];
      return value === undefined ? [] : [{ field, value }];
    }),
    ...courts.map((value) => ({ field: "court" as const, value })),
  ];
  const rows = await caseLawDb(async (tx) => {
    const probes = requested.flatMap(({ field, value }) => {
      const candidates =
        field === "court" ? PUBLIC_CASE_LAW_COUNTRIES : [country];
      return candidates.map((candidate) =>
        caseLawFilterMembershipQuery({ tx, field, value, country: candidate }),
      );
    });
    const first =
      probes.at(0) ??
      panic("A filter membership read requires at least one probe.");
    const second = probes.at(1);
    return second === undefined
      ? await first
      : await unionAll(first, second, ...probes.slice(2));
  });
  for (const row of rows) {
    if (row.value === filters[row.field]) {
      countriesByField[row.field].push(row.country);
    }
  }
  const normalized = normalizeCaseLawCountryFilters({
    country,
    filters,
    countriesByField,
  });
  for (const value of courts) {
    const countries = rows
      .filter((row) => row.field === "court" && row.value === value)
      .map((row) => row.country);
    if (!countries.includes(country)) {
      normalized.removed.push({ field: "court", value, countries });
    }
  }
  return normalized;
};
