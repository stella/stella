import { panic, Result } from "better-result";

import type { VocabularyEntry } from "@stll/agent-input";
import { normalizeVocabularyValue } from "@stll/agent-input";
import { courtAbbreviation } from "@stll/api-contract/court-abbreviations";
import { Temporal } from "@stll/time";

import { readCourtNames } from "@/api/handlers/case-law/decisions/shelf-courts";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
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
 * the shared reader decides which spellings name exactly one court. A court
 * stored under several spellings is one court, and a value naming it filters
 * by all of them. A value that names no court, or several different courts,
 * is dropped with a warning naming the courts,
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

/**
 * One court as the corpus stores it. A publisher spells an apex court more
 * than one way ("Najvyšší súd", "Najvyšší súd Slovenskej republiky"), and the
 * court registry (`courtAbbreviation`) gives every spelling of one apex court
 * the same abbreviation, so spellings sharing it are one court. A court the
 * registry has no abbreviation for is identified by its spelling alone: two
 * such spellings are never merged on a guess.
 */
export type StoredCourtIdentity = {
  abbreviation: string | undefined;
  /** Every stored spelling, in the corpus list's order; never empty. */
  spellings: readonly [string, ...string[]];
};

/** The country's stored courts, grouped by identity, apex courts first. */
export const storedCourtIdentities = (
  country: string,
  courts: readonly string[],
): StoredCourtIdentity[] => {
  const apex = new Map<string, [string, ...string[]]>();
  const byName: StoredCourtIdentity[] = [];
  for (const court of courts) {
    const abbreviation = courtAbbreviation({ country, court });
    if (abbreviation === undefined) {
      byName.push({ abbreviation, spellings: [court] });
      continue;
    }
    const spellings = apex.get(abbreviation);
    if (spellings === undefined) {
      apex.set(abbreviation, [court]);
    } else {
      spellings.push(court);
    }
  }
  // Apex courts first: they are the ones a caller names, so a dropped
  // filter's hint leads with them.
  return [
    ...[...apex].map(([abbreviation, spellings]) => ({
      abbreviation,
      spellings,
    })),
    ...byName,
  ];
};

/**
 * One vocabulary entry per court, not per spelling. The shared reader treats
 * two entries answering to one alias as two readings and asks; two spellings
 * of one court are one reading, so they share an entry, its value the first
 * spelling and the others its aliases.
 */
const courtVocabulary = (
  identities: readonly StoredCourtIdentity[],
): VocabularyEntry[] =>
  identities.map(({ abbreviation, spellings: [value, ...others] }) => ({
    value,
    aliases:
      abbreviation === undefined
        ? others
        : [...others, ...apexCourtAliases(abbreviation)],
  }));

/** An apex court's abbreviation, and its English names where it has any. */
const apexCourtAliases = (abbreviation: string): readonly string[] =>
  Object.hasOwn(APEX_COURT_ENGLISH_NAMES, abbreviation)
    ? [abbreviation, ...(APEX_COURT_ENGLISH_NAMES[abbreviation] ?? [])]
    : [abbreviation];

type CourtFilterReading =
  | {
      type: "court";
      /** Every stored spelling of the court the value named. */
      courts: readonly [string, ...string[]];
      warning: AgentCaseLawSearchWarning | null;
    }
  | { type: "dropped"; warning: AgentCaseLawSearchWarning };

/** Read one court filter against a country's stored courts. */
export const readCourtFilter = ({
  court,
  identities,
}: {
  court: string;
  identities: readonly StoredCourtIdentity[];
}): CourtFilterReading => {
  const read = normalizeVocabularyValue(court, courtVocabulary(identities), {
    label: "The stored courts",
    expected: "a court this corpus holds",
    maxListed: LISTED_COURTS,
  });
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
  const { spellings } =
    identities.find((identity) => identity.spellings[0] === read.value) ??
    panic(`Court vocabulary read a value it does not hold: ${read.value}`);
  return {
    type: "court",
    courts: spellings,
    warning: courtReadWarning({ court, spellings }),
  };
};

/** The note for a court value read as these spellings; none when verbatim. */
const courtReadWarning = ({
  court,
  spellings,
}: {
  court: string;
  spellings: readonly [string, ...string[]];
}): AgentCaseLawSearchWarning | null =>
  spellings.length === 1 && spellings[0] === court
    ? null
    : filterReadWarning({
        filter: "court",
        received: JSON.stringify(court),
        values: spellings,
      });

type CourtFilters = {
  court: string | undefined;
  courts: string[] | undefined;
};

type CombinedCourtFilters = CourtFilters & {
  /** The spellings of `court` the combined filters search; its note's list. */
  courtSpellings: readonly [string, ...string[]] | undefined;
};

/**
 * The request's two court filters once each value is read as its court's
 * spellings. The search ANDs `court` (one spelling) with `courts` (any
 * listed), so a `court` naming a court stored under several spellings moves
 * into `courts`, intersected with the list when there is one. An empty
 * intersection is a contradiction the caller wrote; it is sent as written
 * and matches nothing, exactly as the two filters ask.
 */
export const combineCourtFilters = ({
  court,
  courts,
}: {
  court: readonly [string, ...string[]] | undefined;
  courts: readonly string[] | undefined;
}): CombinedCourtFilters => {
  const listed =
    courts === undefined || courts.length === 0
      ? undefined
      : [...new Set(courts)];
  if (court === undefined) {
    return { court: undefined, courts: listed, courtSpellings: undefined };
  }
  const [only, ...others] = court;
  if (others.length === 0) {
    return { court: only, courts: listed, courtSpellings: [only] };
  }
  if (listed === undefined) {
    return { court: undefined, courts: [...court], courtSpellings: court };
  }
  const [first, ...rest] = listed.filter((spelling) =>
    court.includes(spelling),
  );
  return first === undefined
    ? { court: only, courts: listed, courtSpellings: [only] }
    : {
        court: undefined,
        courts: [first, ...rest],
        courtSpellings: [first, ...rest],
      };
};

/** The `court` value's note, from the spellings the combined filters search. */
const combinedCourtWarning = ({
  court,
  reading,
  spellings,
}: {
  court: string;
  reading: CourtFilterReading;
  spellings: CombinedCourtFilters["courtSpellings"];
}): AgentCaseLawSearchWarning | null => {
  if (reading.type === "dropped") {
    return reading.warning;
  }
  return courtReadWarning({
    court,
    spellings:
      spellings ?? panic("A court reading combined into no court spellings"),
  });
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
  courts: requestedCourts,
}: {
  context: McpRequestContext;
  country: string;
  court: string | undefined;
  courts?: string[] | undefined;
}): Promise<CourtFilters & { warnings: AgentCaseLawSearchWarning[] }> => {
  if (court === undefined && requestedCourts === undefined) {
    return { court, courts: undefined, warnings: [] };
  }
  const courts = await loadCaseLawCourtNames(context, country);
  if (courts === null) {
    return { court, courts: requestedCourts, warnings: [] };
  }
  const identities = storedCourtIdentities(country, courts);
  const listWarnings: AgentCaseLawSearchWarning[] = [];
  const courtReading =
    court === undefined ? undefined : readCourtFilter({ court, identities });
  const combined = combineCourtFilters({
    court: courtReading?.type === "court" ? courtReading.courts : undefined,
    courts: requestedCourts?.flatMap((value) => {
      const reading = readCourtFilter({ court: value, identities });
      if (reading.warning !== null) {
        listWarnings.push(reading.warning);
      }
      return reading.type === "court" ? [...reading.courts] : [];
    }),
  });
  // A several-spelling `court` combined with `courts` searches only the
  // spellings both allow, or its first spelling when they contradict, so its
  // note is written from the combined filter, not from the reading alone.
  const courtWarning =
    court === undefined || courtReading === undefined
      ? null
      : combinedCourtWarning({
          court,
          reading: courtReading,
          spellings: combined.courtSpellings,
        });
  return {
    court: combined.court,
    courts: combined.courts,
    warnings:
      courtWarning === null ? listWarnings : [courtWarning, ...listWarnings],
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
const loadCaseLawCourtNames = async (
  context: McpRequestContext,
  country: string,
): Promise<readonly string[] | null> => {
  const read = context.testDependencies?.readCaseLawCourtNames;
  if (read !== undefined) {
    return await read(country);
  }
  const courts = await Result.tryPromise({
    try: async () =>
      await withTimeout(async () => await readCachedCourtNames(country), {
        label: "case-law-court-filter-vocabulary",
        timeoutMs: COURT_NAMES_READ_TIMEOUT_MS,
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(courts)) {
    observeFailure(courts.error, { sink: COURT_FILTER_VOCABULARY_SINK });
    return null;
  }
  return courts.value;
};
