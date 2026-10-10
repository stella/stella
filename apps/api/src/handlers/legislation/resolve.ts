import { inArray } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT } from "@stll/api-contract/legislation-expression";
import { PUBLIC_LEGISLATION_COUNTRIES } from "@stll/api-contract/legislation-publication";

import { legislationDocuments } from "@/api/db/schema";
import { projectResolveStatutesResponse } from "@/api/handlers/legislation/catalog-response";
import { resolveWorksAtDate } from "@/api/lib/legal-search/legislation-works-at-date";
import type { WorkAtDateRequest } from "@/api/lib/legal-search/legislation-works-at-date";
import {
  readPublicLawCountry,
  tPublicLawCountry,
} from "@/api/lib/legal-search/public-law-country";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";
import { LIMITS } from "@/api/lib/limits";

export const resolveStatutesBodySchema = t.Object({
  works: t.Array(
    t.Object({
      /** Jurisdiction of the cited work, which need not be the reader's own. */
      country: tPublicLawCountry,
      eli: t.String({ minLength: 1, maxLength: LIMITS.legislationEliMaxChars }),
      /** Date whose applicable consolidation should answer for the work. */
      asOf: t.String({ format: "date" }),
    }),
    { maxItems: LIMITS.legislationResolveWorksMax },
  ),
});

type ResolveStatutesBody = Static<typeof resolveStatutesBodySchema>;

/** What a link to a consolidation needs, the same fields the list returns. */
const resolvedStatuteColumns = {
  id: legislationDocuments.id,
  eli: legislationDocuments.eli,
  slug: legislationDocuments.slug,
  title: legislationDocuments.title,
  country: legislationDocuments.country,
  language: legislationDocuments.language,
  versionValidFrom: legislationDocuments.versionValidFrom,
  versionValidTo: legislationDocuments.versionValidTo,
  expressionKind: legislationDocuments.expressionKind,
  windowDisposition: legislationDocuments.windowDisposition,
};

/**
 * Many point-in-time reads at once: for each Work plus date, the consolidation
 * in force then, or null when the corpus holds none.
 *
 * A null answer says why when the corpus knows: `unresolvedReason` is
 * `publisher-data-inconsistent` when the publisher's own dates leave that
 * date without an in-force reading, so a citator can show the reason rather
 * than silence. It is null otherwise.
 *
 * A reader linking a decision's citations asks about every act the text
 * names; answering them together keeps that one request however many acts
 * are cited. Each answer echoes the request it answers, in request order, so
 * the caller matches on what it sent. A country this surface cannot read or
 * holds no law for answers null rather than failing the batch: one odd
 * citation must not unlink the others.
 */
export const resolveStatutesHandler = async (
  body: ResolveStatutesBody,
  legislationDb: LegislationReadDb,
) => {
  const requests: WorkAtDateRequest[] = [];
  for (const [index, work] of body.works.entries()) {
    const countryRead = readPublicLawCountry(work.country, {
      admitted: PUBLIC_LEGISLATION_COUNTRIES,
    });
    if (countryRead.kind === "read") {
      requests.push({
        key: String(index),
        country: countryRead.country,
        eli: work.eli,
        asOf: work.asOf,
      });
    }
  }

  const { idByKey, inconsistentKeys, statutes } = await legislationDb(
    async (tx) => {
      const resolved = await resolveWorksAtDate(tx, requests);
      const ids = [...new Set(resolved.idByKey.values())];

      return {
        idByKey: resolved.idByKey,
        inconsistentKeys: resolved.inconsistentKeys,
        statutes:
          ids.length === 0
            ? []
            : await tx
                .select(resolvedStatuteColumns)
                .from(legislationDocuments)
                .where(inArray(legislationDocuments.id, ids)),
      };
    },
  );

  const statuteById = new Map(statutes.map((row) => [row.id, row]));

  return projectResolveStatutesResponse({
    items: body.works.map((work, index) => {
      const countryRead = readPublicLawCountry(work.country, {
        admitted: PUBLIC_LEGISLATION_COUNTRIES,
      });
      if (countryRead.kind === "unavailable") {
        return {
          ...work,
          statute: null,
          unresolvedReason: countryRead.answer.response.reason,
          availability: countryRead.answer.response,
        };
      }
      const key = String(index);
      const id = idByKey.get(key);
      const statute = id === undefined ? null : (statuteById.get(id) ?? null);
      return {
        country: work.country,
        eli: work.eli,
        asOf: work.asOf,
        statute,
        unresolvedReason:
          statute === null && inconsistentKeys.has(key)
            ? LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT
            : null,
      };
    }),
  });
};
