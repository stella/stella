import { panic } from "better-result";

import { isAbsentPlaceholder } from "@stll/agent-input";
import { courtAbbreviation } from "@stll/api-contract/case-law-court-abbreviations";
import {
  type CourtCitationIndex,
  courtCitationIndex,
  foldCourtText,
  readCourtCitation,
  storedCourtIdentity,
} from "@stll/api-contract/court-citation-aliases";
import { createTtlFlightCache } from "@stll/concurrency/ttl-flight-cache";
import { Temporal } from "@stll/time";

import { readCourtNames } from "@/api/handlers/case-law/decisions/shelf-courts";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type { AgentCaseLawSearchWarning } from "@/api/lib/case-law/search-warnings";
import {
  filterDroppedWarning,
  filterNotHeldWarning,
  filterReadWarning,
  filterUnreadWarning,
} from "@/api/lib/case-law/search-warnings";
import { runBoundedRequestStep } from "@/api/lib/load/request-latency-budget";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type { McpRequestContext } from "@/api/mcp/context";

/**
 * A court filter as an agent writes it, read onto the courts the corpus
 * stores decisions under.
 *
 * The search compares `court` by equality, so a filter that is not a stored
 * spelling returns nothing and the caller cannot tell that from "no such
 * decisions". The value is read through the court identity the decision
 * resolver holds a citation to (`court-citation-aliases.ts`): the country's
 * court directory with every alias its grammar generates (declined names,
 * short codes, seats in either case, Prague's numbered forms, branches), each
 * court's ECLI code, and every name the corpus stores decisions under. Any
 * alias the resolver reads as a court filters exactly that court, by every
 * stored spelling of it, and never a court that merely shares words with it:
 * a regional court's branch is its own court, never its main court.
 *
 * A value that names no court, an alias two courts answer to, or a court no
 * stored decision is filed under is dropped with a warning naming the stored
 * courts nearest to it, so the search still answers: an optional filter
 * narrows a search, it never empties one, and it never narrows to a court the
 * caller did not name.
 *
 * The reading is a function of the value and the country's stored names
 * alone, never of the page, so a continuation call carrying the same filter
 * reads it the same way and resumes the same search.
 */

/** How many courts a dropped filter's hint names. */
const LISTED_COURTS = 12;

/** One court a filter value can name, with the spellings decisions carry. */
type StoredCourtIdentity = {
  /** The court-identity key, shared with the decision resolver. */
  key: string;
  /** The court's directory name, or its stored name outside the directory. */
  name: string;
  /** Every stored spelling, in the corpus list's order; empty when none. */
  spellings: readonly string[];
};

/** A country's courts as the filter reads them. */
export type StoredCourtCatalog = {
  index: CourtCitationIndex;
  /** Every court a value can name: the directory's first, then stored names. */
  identities: ReadonlyMap<string, StoredCourtIdentity>;
};

const UNPLACED_KEY_INFIX = ":unplaced:";

/**
 * The country's courts, each with the stored spellings that place a decision
 * at it. A stored name that only an alias two courts share could place is its
 * own identity, read by that exact spelling alone.
 */
export const storedCourtCatalog = (
  country: string,
  storedNames: readonly string[],
): StoredCourtCatalog => {
  const index = courtCitationIndex(country, storedNames);
  // Every court the index holds, none yet with a stored spelling; the index
  // holds every stored name, so each placed name lands on one of these.
  const identities = new Map<
    string,
    StoredCourtIdentity & { spellings: string[] }
  >(
    [...index.courts].map(([key, { name }]) => [
      key,
      { key, name, spellings: [] },
    ]),
  );
  for (const name of new Set(storedNames)) {
    const { key } = storedCourtIdentity(index, { court: name, ecli: null });
    // A name only an alias two courts share could place stays its own court.
    const unplacedKey = `${country}${UNPLACED_KEY_INFIX}${name}`;
    const identity =
      key === undefined
        ? { key: unplacedKey, name, spellings: [] }
        : (identities.get(key) ??
          panic(`A stored court name placed outside the index: ${name}`));
    identity.spellings.push(name);
    identities.set(identity.key, identity);
  }
  return { index, identities };
};

/**
 * The courts a filter value names: the courts its whole text is an alias of,
 * else the courts a citation's court words would constrain to. Words naming a
 * court no alias reads (an unknown seat, a branch the directory lacks) name
 * no court, never the court their known words would.
 */
const courtKeysNamed = (
  catalog: StoredCourtCatalog,
  value: string,
): readonly string[] => {
  // A stored spelling only an ambiguous alias could place is read by that
  // exact spelling before the alias it shares.
  const unplacedKey = `${catalog.index.country}${UNPLACED_KEY_INFIX}${value}`;
  if (catalog.identities.has(unplacedKey)) {
    return [unplacedKey];
  }
  const whole = catalog.index.byAlias.get(foldCourtText(value).join(" "));
  if (whole !== undefined) {
    return [...whole].toSorted();
  }
  const keys = new Set<string>();
  for (const constraint of readCourtCitation(catalog.index, value)) {
    if (constraint.type === "unrecognized") {
      return [];
    }
    if (constraint.type === "ecli-code") {
      if (constraint.court === undefined) {
        return [];
      }
      keys.add(constraint.court);
      continue;
    }
    for (const key of constraint.courts) {
      keys.add(key);
    }
  }
  return [...keys].toSorted();
};

type StoredCourtWords = { first: string; folded: ReadonlySet<string> };

/** Each catalog's stored courts with their folded words, folded once. */
const storedWordsByCatalog = new WeakMap<
  StoredCourtCatalog,
  readonly StoredCourtWords[]
>();

/** The courts a decision is stored under, in catalog order, with their words. */
const storedCourtWords = (
  catalog: StoredCourtCatalog,
): readonly StoredCourtWords[] => {
  const cached = storedWordsByCatalog.get(catalog);
  if (cached !== undefined) {
    return cached;
  }
  const stored: StoredCourtWords[] = [];
  for (const { name, spellings } of catalog.identities.values()) {
    const [first] = spellings;
    if (first !== undefined) {
      stored.push({
        first,
        folded: new Set(
          [name, ...spellings].flatMap((spelling) => foldCourtText(spelling)),
        ),
      });
    }
  }
  storedWordsByCatalog.set(catalog, stored);
  return stored;
};

/**
 * The stored courts nearest a value, for a dropped filter's hint: those
 * sharing the most of its words first, then the catalog's order, in which
 * the apex courts lead.
 */
const nearestStoredCourts = (
  catalog: StoredCourtCatalog,
  value: string,
): readonly string[] => {
  const words = new Set(foldCourtText(value));
  return storedCourtWords(catalog)
    .map(({ first, folded }, position) => ({
      first,
      position,
      score: [...folded].filter((word) => words.has(word)).length,
    }))
    .toSorted(
      (left, right) =>
        right.score - left.score || left.position - right.position,
    )
    .slice(0, LISTED_COURTS)
    .map(({ first }) => first);
};

const quoted = (values: readonly string[]): string =>
  values.map((value) => `"${value}"`).join(", ");

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
  catalog,
}: {
  court: string;
  catalog: StoredCourtCatalog;
}): CourtFilterReading => {
  const received = JSON.stringify(court);
  if (isAbsentPlaceholder(court)) {
    return {
      type: "dropped",
      warning: filterDroppedWarning({
        filter: "court",
        received,
        known: "Omit court to search every court.",
      }),
    };
  }
  const nearest = (): string => {
    const listed = nearestStoredCourts(catalog, court);
    return listed.length === 0
      ? "No court is stored for this country; omit court to search every court."
      : `The stored courts include ${quoted(listed)}.`;
  };
  const named = courtKeysNamed(catalog, court).map(
    (key) =>
      catalog.identities.get(key) ??
      panic(`A court reading named a court outside the catalog: ${key}`),
  );
  const [only, ...others] = named;
  if (only === undefined) {
    return {
      type: "dropped",
      warning: filterDroppedWarning({
        filter: "court",
        received,
        known: nearest(),
      }),
    };
  }
  if (others.length > 0) {
    return {
      type: "dropped",
      warning: filterDroppedWarning({
        filter: "court",
        received,
        known: `It answers to ${String(named.length)} courts, ${quoted(named.map(({ name }) => name))}; name one of them.`,
      }),
    };
  }
  const [first, ...rest] = only.spellings;
  if (first === undefined) {
    return {
      type: "dropped",
      warning: filterNotHeldWarning({
        filter: "court",
        received,
        value: only.name,
        known: nearest(),
      }),
    };
  }
  const spellings: readonly [string, ...string[]] = [first, ...rest];
  return {
    type: "court",
    courts: spellings,
    // The apex abbreviations the tool description advertises (`NS`, `ÚS`)
    // are the documented call; treating one as a repair would make it noisy.
    warning:
      court ===
      courtAbbreviation({ country: catalog.index.country, court: first })
        ? null
        : courtReadWarning({ court, spellings }),
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
  if (reading.warning === null) {
    return null;
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
    return {
      court,
      courts: requestedCourts,
      warnings: [filterUnreadWarning({ filter: "court" })],
    };
  }
  const catalog = cachedStoredCourtCatalog(country, courts);
  const listWarnings: AgentCaseLawSearchWarning[] = [];
  const courtReading =
    court === undefined ? undefined : readCourtFilter({ court, catalog });
  const combined = combineCourtFilters({
    court: courtReading?.type === "court" ? courtReading.courts : undefined,
    courts: requestedCourts?.flatMap((value) => {
      const reading = readCourtFilter({ court: value, catalog });
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
  const warnings = [
    ...(courtWarning === null ? [] : [courtWarning]),
    ...listWarnings,
  ];
  const warningKeys = new Set<string>();
  return {
    court: combined.court,
    courts: combined.courts,
    warnings: warnings.filter(({ code, message, hint }) => {
      const key = JSON.stringify([code, message, hint]);
      if (warningKeys.has(key)) {
        return false;
      }
      warningKeys.add(key);
      return true;
    }),
  };
};

/**
 * One catalog per court list read: the list itself is cached for minutes, so
 * every search in that window shares the catalog built from it.
 */
const catalogs = new WeakMap<readonly string[], StoredCourtCatalog>();

const cachedStoredCourtCatalog = (
  country: string,
  courts: readonly string[],
): StoredCourtCatalog => {
  const cached = catalogs.get(courts);
  if (cached?.index.country === country) {
    return cached;
  }
  const catalog = storedCourtCatalog(country, courts);
  catalogs.set(courts, catalog);
  return catalog;
};

/** The court list changes when a source adds a court, which is rare. */
const COURT_NAMES_CACHE_TTL_MS = 10 * 60_000;

/**
 * A filter reading is presentation of the caller's intent, not a gate, so the
 * list read gets a short sub-budget of the search's own: without the list the
 * filter is used as sent, and the search says so.
 */
const COURT_NAMES_READ_BUDGET_MS = 1500;

const COURT_FILTER_VOCABULARY_SINK = failureSink({
  event: "mcp.case_law.court_filter_vocabulary_unavailable",
  expected: [],
});

/** One entry per country; a failed read is dropped, never served. */
const courtNamesCache = createTtlFlightCache<readonly string[]>({
  ttlMs: COURT_NAMES_CACHE_TTL_MS,
  maxEntries: 64,
  now: () => Temporal.Now.instant().epochMilliseconds,
});

const readCachedCourtNames = async (
  country: string,
): Promise<readonly string[]> =>
  await courtNamesCache.read(
    country,
    async () =>
      await readCourtNames({ caseLawDb: caseLawPublicReadDb, country }),
  );

/**
 * The country's stored courts, or null when they cannot be read in time. A
 * null list leaves the filter as sent, and the search reports it with a
 * `filter_unread` warning rather than waiting the list out.
 */
export const loadCaseLawCourtNames = async (
  context: McpRequestContext,
  country: string,
): Promise<readonly string[] | null> => {
  const read =
    context.testDependencies?.readCaseLawCourtNames ?? readCachedCourtNames;
  const courts = await runBoundedRequestStep(async () => await read(country), {
    label: "case-law-court-filter-vocabulary",
    budgetMs: COURT_NAMES_READ_BUDGET_MS,
  });
  if (courts.status === "complete") {
    return courts.value;
  }
  // A spent budget is graded `timeout_budgeted`; any other failure keeps its
  // own grade.
  observeFailure(courts.error, { sink: COURT_FILTER_VOCABULARY_SINK });
  return null;
};
