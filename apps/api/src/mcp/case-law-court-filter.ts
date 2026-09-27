import type { VocabularyEntry } from "@stll/agent-input";
import { normalizeVocabularyValue } from "@stll/agent-input";
import { Temporal } from "@stll/time";

import { readCourtNames } from "@/api/handlers/case-law/decisions/shelf-courts";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { courtAbbreviation } from "@/api/lib/case-law/court-abbreviations";
import type { AgentCaseLawSearchWarning } from "@/api/lib/case-law/search-warnings";
import {
  filterDroppedWarning,
  filterReadWarning,
} from "@/api/lib/case-law/search-warnings";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { withTimeout } from "@/api/lib/with-timeout";
import type { McpRequestContext } from "@/api/mcp/context";

/**
 * A court filter as an agent writes it, read onto a court the corpus stores.
 *
 * The search compares `court` by equality, so a filter that is not a stored
 * spelling returns nothing and the caller cannot tell that from "no such
 * decisions". Agents write the court the way their prompt or training did:
 * `NS`, `Constitutional Court`, `Ústavní soud České republiky`, or a country
 * where a court belongs. The corpus's own court list is the vocabulary, and
 * the shared reader decides which spellings name exactly one court. A value
 * that names none, or several, is dropped with a warning naming the courts,
 * so the search still answers: an optional filter narrows a search, it never
 * empties one.
 *
 * The reading is a function of the value and the country alone, never of the
 * page, so a continuation call carrying the same filter reads it the same way
 * and resumes the same search.
 */

/**
 * Working English names of the apex courts, keyed by the abbreviation
 * `courtAbbreviation` derives for them. The stored name is the publisher's,
 * in its own language; a model asked in English writes these.
 */
const APEX_COURT_ENGLISH_NAMES: Readonly<Record<string, readonly string[]>> = {
  ÚS: ["Constitutional Court"],
  NS: ["Supreme Court"],
  NSS: ["Supreme Administrative Court"],
  SN: ["Supreme Court"],
  NSA: ["Supreme Administrative Court"],
  TK: ["Constitutional Tribunal", "Constitutional Court"],
  AB: ["Constitutional Court"],
  Kúria: ["Curia", "Supreme Court"],
  CJEU: ["Court of Justice", "Court of Justice of the European Union", "ECJ"],
  GC: ["General Court"],
};

/** How many courts a dropped filter's hint names. */
const LISTED_COURTS = 12;

const courtVocabulary = (
  country: string,
  courts: readonly string[],
): VocabularyEntry[] =>
  courts
    .map((court) => {
      const abbreviation = courtAbbreviation({ country, court });
      return {
        value: court,
        aliases:
          abbreviation === undefined
            ? []
            : [abbreviation, ...(APEX_COURT_ENGLISH_NAMES[abbreviation] ?? [])],
        // Apex courts first: they are the ones a caller names, so a dropped
        // filter's hint leads with them.
        apex: abbreviation !== undefined,
      };
    })
    .toSorted((left, right) => Number(right.apex) - Number(left.apex))
    .map(({ value, aliases }) => ({ value, aliases }));

export type CourtFilterReading =
  | { type: "court"; court: string; warning: AgentCaseLawSearchWarning | null }
  | { type: "dropped"; warning: AgentCaseLawSearchWarning };

/** Read one court filter against a country's stored courts. */
export const readCourtFilter = ({
  country,
  court,
  courts,
}: {
  country: string;
  court: string;
  courts: readonly string[];
}): CourtFilterReading => {
  const read = normalizeVocabularyValue(
    court,
    courtVocabulary(country, courts),
    {
      label: "The stored courts",
      expected: "a court this corpus holds",
      maxListed: LISTED_COURTS,
    },
  );
  const received = JSON.stringify(court);
  if (read.ok === "absent") {
    return {
      type: "dropped",
      warning: filterDroppedWarning({
        filter: "court",
        received,
        known: "Omit court to search every court.",
      }),
    };
  }
  if (!read.ok) {
    return {
      type: "dropped",
      warning: filterDroppedWarning({
        filter: "court",
        received,
        known: read.hint,
      }),
    };
  }
  return {
    type: "court",
    court: read.value,
    warning:
      read.value === court
        ? null
        : filterReadWarning({ filter: "court", received, value: read.value }),
  };
};

/**
 * The court a search narrows by, and the warning that reports how the
 * caller's value was read. No court list (an unreadable corpus) leaves the
 * value as sent.
 */
export const resolveCourtFilter = async ({
  context,
  country,
  court,
}: {
  context: McpRequestContext;
  country: string;
  court: string | undefined;
}): Promise<{
  court: string | undefined;
  warnings: AgentCaseLawSearchWarning[];
}> => {
  if (court === undefined) {
    return { court, warnings: [] };
  }
  const courts = await loadCaseLawCourtNames(context, country);
  if (courts === null) {
    return { court, warnings: [] };
  }
  const reading = readCourtFilter({ country, court, courts });
  return {
    court: reading.type === "court" ? reading.court : undefined,
    warnings: reading.warning === null ? [] : [reading.warning],
  };
};

/** The court list changes when a source adds a court, which is rare. */
const COURT_NAMES_CACHE_TTL_MS = 10 * 60_000;

/**
 * A filter reading is presentation of the caller's intent, not a gate, so the
 * list read gets a short budget: without it the filter is used as sent.
 */
const COURT_NAMES_READ_TIMEOUT_MS = 1500;

const COURT_FILTER_VOCABULARY_SINK = failureSink({
  event: "mcp.case_law.court_filter_vocabulary_unavailable",
  expected: [],
});

const courtNamesCache = new Map<
  string,
  { expiresAt: number; courts: Promise<readonly string[]> }
>();

const readCachedCourtNames = async (
  country: string,
): Promise<readonly string[]> => {
  const now = Temporal.Now.instant().epochMilliseconds;
  const cached = courtNamesCache.get(country);
  if (cached !== undefined && cached.expiresAt > now) {
    return await cached.courts;
  }
  const courts = readCourtNames({ caseLawDb: caseLawPublicReadDb, country });
  courtNamesCache.set(country, {
    expiresAt: now + COURT_NAMES_CACHE_TTL_MS,
    courts,
  });
  // A failed read must not be served from the cache for ten minutes. The
  // caller awaiting `courts` observes the failure itself.
  courts.catch((_failure: unknown) => courtNamesCache.delete(country));
  return await courts;
};

/**
 * The country's stored courts, or null when they cannot be read in time. A
 * null list leaves the filter as sent: the search then answers exactly as it
 * did before this reader existed, which is the honest degradation.
 */
export const loadCaseLawCourtNames = async (
  context: McpRequestContext,
  country: string,
): Promise<readonly string[] | null> => {
  const read = context.testDependencies?.readCaseLawCourtNames;
  if (read !== undefined) {
    return await read(country);
  }
  try {
    return await withTimeout(async () => await readCachedCourtNames(country), {
      label: "case-law-court-filter-vocabulary",
      timeoutMs: COURT_NAMES_READ_TIMEOUT_MS,
    });
  } catch (error) {
    observeFailure(error, { sink: COURT_FILTER_VOCABULARY_SINK });
    return null;
  }
};
