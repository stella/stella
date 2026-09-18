/**
 * Import the Czech Constitutional Court's published roster of its justices
 * into `case_law_judges`, then re-link the decision rows whose printed name
 * had no roster row when they were ingested.
 *
 * The court publishes two listings, sitting and emeritus. Each entry links to
 * the justice's own page through a URL the listing computes, so those pages
 * are reachable only by following the links a listing states; nothing here
 * constructs one.
 *
 * The parsers are pure functions of the served markup, so the captures in
 * `__fixtures__` exercise them exactly as a run does. The database and object
 * store are reached through the two ports below, whose production
 * implementations pull their connections in on first use: importing this
 * module opens nothing.
 */

import { panic, Result, TaggedError } from "better-result";
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { and, eq } from "drizzle-orm";

import { caseLawJudges } from "@/api/db/schema";
import {
  INGESTION_USER_AGENT,
  parseCeDate,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import type {
  JudgeExternalRefs,
  PortraitSource,
} from "@/api/handlers/case-law/judges/consts";
import { PORTRAIT_SOURCE } from "@/api/handlers/case-law/judges/consts";
import { relinkUnmatchedDecisionJudges } from "@/api/handlers/case-law/judges/decision-judges";
import {
  judgeNameKey,
  stripAcademicTitles,
} from "@/api/handlers/case-law/judges/judge-name";
import { PORTRAIT_MAX_BYTES } from "@/api/handlers/case-law/judges/portrait";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { CZ_ECLI_COURTS } from "@/api/lib/case-law/ecli-court-codes";
import type { CaseLawIngestionHandle } from "@/api/lib/case-law/maintenance-lane";
import { logger } from "@/api/lib/observability/logger";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";

/* -- the source ---------------------------------------------------------- */

const COURT_SITE_ORIGIN = "https://www.usoud.cz";

/**
 * Every request a run makes stays on the court's own site. Profile and
 * portrait links are read out of fetched markup, so they are input rather
 * than configuration, and the origin is checked before each one is opened.
 */
const COURT_SITE_POLICY = {
  type: "exact-origin",
  origins: [COURT_SITE_ORIGIN],
} as const;

/** The two listings the court publishes, sitting justices first. */
export const CZ_US_ROSTER_LISTINGS = [
  `${COURT_SITE_ORIGIN}/soucasni-funkcionari-a-soudci`,
  `${COURT_SITE_ORIGIN}/emeritni-funkcionari-a-soudci`,
] as const;

const CZ_US_COUNTRY = "CZE";
const CZ_US_COURT = CZ_ECLI_COURTS.US;
/** The court credits its own portraits, so the attribution is its name. */
const PORTRAIT_ATTRIBUTION = CZ_ECLI_COURTS.US;
const PORTRAIT_KEY_PREFIX = "case-law/judges/";

const REQUEST_TIMEOUT_MS = 30_000;

/** The gap a run leaves between two requests to the court's site. */
export const CZ_US_ROSTER_REQUEST_INTERVAL_MS = 1000;

/**
 * The image types the court serves, and the extension the stored object
 * carries. A type outside the map is reported rather than guessed at: the
 * extension is part of the object key, so a wrong guess is durable.
 */
const PORTRAIT_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const satisfies Readonly<Record<string, string>>;

export type PortraitContentType = keyof typeof PORTRAIT_EXTENSIONS;

type ServedPortraitType = {
  contentType: PortraitContentType;
  extension: string;
};

const isPortraitContentType = (value: string): value is PortraitContentType =>
  Object.hasOwn(PORTRAIT_EXTENSIONS, value);

const servedPortraitType = (header: string): ServedPortraitType | undefined => {
  const declared = header.split(";").at(0)?.trim().toLowerCase() ?? "";
  return isPortraitContentType(declared)
    ? { contentType: declared, extension: PORTRAIT_EXTENSIONS[declared] }
    : undefined;
};

/* -- parsing ------------------------------------------------------------- */

export class CzUsRosterParseError extends TaggedError("CzUsRosterParseError")<{
  message: string;
  sourceUrl: string;
}> {}

export class CzUsRosterFetchError extends TaggedError("CzUsRosterFetchError")<{
  message: string;
  sourceUrl: string;
}> {}

export class CzUsRosterListingError extends TaggedError(
  "CzUsRosterListingError",
)<{
  message: string;
  httpStatus: number;
  listingUrl: string;
}> {}

/**
 * The offices the court prints for a member of its bench.
 *
 * The general secretary is listed among the justices and is court staff, not
 * one of them. The same person can hold both offices, so an entry naming only
 * the secretariat is not a roster row and must not overwrite the justice of
 * that name.
 */
const BENCH_OFFICES = [
  "soudce",
  "soudkyně",
  "předseda",
  "předsedkyně",
  "místopředseda",
  "místopředsedkyně",
] as const;

const normalizeSpace = (value: string): string =>
  value.replaceAll(/\s+/gu, " ").trim();

/**
 * A date the court prints as `1. 1. 2020`. `do` in front of one is what marks
 * it as the end of a term rather than its start, and the court omits `od` in
 * front of a start often enough that its presence cannot be required.
 */
const TERM_DATE_PATTERN =
  /(?:\b(?<until>do)\s+)?(?<date>\d{1,2}\.\s*\d{1,2}\.\s*\d{4})/gu;

export type JusticeTerm = {
  termStart?: string;
  termEnd?: string;
};

const isBenchLine = (line: string): boolean => {
  const office = line.toLowerCase();
  return BENCH_OFFICES.some(
    (candidate) => office === candidate || office.startsWith(`${candidate} `),
  );
};

type OfficeSpan = {
  start: string | undefined;
  end: string | undefined;
};

const parseOfficeSpan = (line: string): OfficeSpan => {
  let start: string | undefined;
  let end: string | undefined;
  for (const match of line.matchAll(TERM_DATE_PATTERN)) {
    const printed = match.groups?.["date"];
    const parsed = printed === undefined ? undefined : parseCeDate(printed);
    if (parsed === undefined) {
      continue;
    }
    if (match.groups?.["until"] === undefined) {
      start ??= parsed;
    } else {
      end = parsed;
    }
  }
  return { start, end };
};

const earliest = (dates: readonly string[]): string | undefined =>
  [...dates].sort().at(0);

const latest = (dates: readonly string[]): string | undefined =>
  [...dates].sort().at(-1);

/**
 * The term a roster entry states, as one span.
 *
 * The court prints a line per office held, and a person can hold several: a
 * justice later appointed president, a justice appointed to two terms. The
 * row carries one span, so it is the envelope of those lines — the earliest
 * start, and an end only where every office has one, because an office still
 * running means the justice still sits.
 *
 * `undefined` means the entry names no bench office at all, which is how a
 * listing's non-judicial entries are told from a justice whose dates the
 * court did not print.
 */
export const parseJusticeTerm = (
  lines: readonly string[],
): JusticeTerm | undefined => {
  const spans = lines.filter(isBenchLine).map(parseOfficeSpan);
  if (spans.length === 0) {
    return undefined;
  }
  const termStart = earliest(
    spans.flatMap((span) => (span.start === undefined ? [] : [span.start])),
  );
  const ends = spans.map((span) => span.end);
  const termEnd = ends.includes(undefined)
    ? undefined
    : latest(ends.filter((end) => end !== undefined));
  return {
    ...(termStart === undefined ? {} : { termStart }),
    ...(termEnd === undefined ? {} : { termEnd }),
  };
};

/** The office lines of one entry, as the court breaks them. */
const officeLines = (paragraph: cheerio.Cheerio<AnyNode>): string[] => {
  paragraph.find("br").replaceWith("\n");
  return paragraph
    .text()
    .split("\n")
    .map(normalizeSpace)
    .filter((line) => line.length > 0);
};

export type RosterListingEntry = {
  name: string;
  /** Absolute, resolved from the link the listing states. */
  profileUrl: string;
  appointedOn?: string;
};

export type RosterListingOptions = {
  html: string;
  listingUrl: string;
};

/**
 * The bench members a listing states, in the order it prints them. An entry
 * naming no bench office is not a roster row and is left out.
 */
export const parseRosterListing = ({
  html,
  listingUrl,
}: RosterListingOptions): RosterListingEntry[] => {
  const $ = cheerio.load(html);
  const entries: RosterListingEntry[] = [];
  $(".judges-list a.list_polozka").each((_, element) => {
    const anchor = $(element);
    const href = anchor.attr("href");
    const printed = normalizeSpace(anchor.find("h3").first().text());
    if (href === undefined || printed.length === 0) {
      return;
    }
    const term = parseJusticeTerm(officeLines(anchor.find("p").first()));
    if (term === undefined) {
      return;
    }
    entries.push({
      name: stripAcademicTitles(printed),
      profileUrl: new URL(href, listingUrl).href,
      ...(term.termStart === undefined ? {} : { appointedOn: term.termStart }),
    });
  });
  return entries;
};

export type ParsedJusticePage = {
  fullName: string;
  termStart?: string;
  termEnd?: string;
  /** Absolute, resolved from the link the page states. */
  portraitUrl?: string;
  sourceUrl: string;
};

export type JusticePageOptions = {
  html: string;
  sourceUrl: string;
};

/** What one justice's own page states about them. */
export const parseJusticePage = ({
  html,
  sourceUrl,
}: JusticePageOptions): Result<ParsedJusticePage, CzUsRosterParseError> => {
  const $ = cheerio.load(html);
  const printed = normalizeSpace($("h1.judges_name").first().text());
  if (printed.length === 0) {
    return Result.err(
      new CzUsRosterParseError({
        message: "justice page states no name",
        sourceUrl,
      }),
    );
  }
  const portraitSrc = $("#judges_detail .obrazek img").first().attr("src");
  return Result.ok({
    fullName: stripAcademicTitles(printed),
    ...parseJusticeTerm(officeLines($("p.perex").first())),
    ...(portraitSrc === undefined || portraitSrc.length === 0
      ? {}
      : { portraitUrl: new URL(portraitSrc, sourceUrl).href }),
    sourceUrl,
  });
};

/* -- ports --------------------------------------------------------------- */

export type CaseLawJudgeId = SafeId<"caseLawJudge">;

export type StoredRosterJudge = {
  id: CaseLawJudgeId;
  fullName: string;
  termStart: string | null;
  termEnd: string | null;
  externalRefs: JudgeExternalRefs;
  portraitS3Key: string | null;
};

export type NewRosterJudge = {
  id: CaseLawJudgeId;
  fullName: string;
  nameKey: string;
  termStart: string | null;
  termEnd: string | null;
  externalRefs: JudgeExternalRefs;
};

/**
 * A patch carries only what the court's statement changes. The four portrait
 * columns move together, because the row's check constraint holds them all
 * null or all set.
 */
export type RosterJudgePatch = {
  fullName?: string;
  termStart?: string | null;
  termEnd?: string | null;
  externalRefs?: JudgeExternalRefs;
  portraitS3Key?: string;
  portraitSource?: PortraitSource;
  portraitAttribution?: string;
  portraitContentType?: PortraitContentType;
  updatedAt?: Date;
};

export type InsertedRosterJudge = {
  id: CaseLawJudgeId;
  inserted: boolean;
};

/**
 * The database operations a run performs, narrowed so the import is driven
 * without one. `czUsRosterStore` builds the production implementation.
 */
export type CzUsRosterStore = {
  findByNameKey: (nameKey: string) => Promise<StoredRosterJudge | undefined>;
  /**
   * Inserts unless the roster key already holds a row, and answers which row
   * the key names now: `inserted: false` is a concurrent run having won it.
   */
  insertJudge: (judge: NewRosterJudge) => Promise<InsertedRosterJudge>;
  updateJudge: (options: {
    id: CaseLawJudgeId;
    patch: RosterJudgePatch;
  }) => Promise<void>;
  relinkUnmatched: () => Promise<number>;
};

export type RosterPortrait = {
  key: string;
  bytes: Uint8Array;
  contentType: PortraitContentType;
};

/**
 * The fetch a run makes its requests through. Narrower than the platform's:
 * every URL is rebuilt from the court's origin before it is opened, so a
 * `Request` never reaches it.
 */
export type RosterFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

export type RosterPortraitStore = {
  put: (portrait: RosterPortrait) => Promise<void>;
};

/* -- the import ---------------------------------------------------------- */

export type RosterImportFailure = {
  name: string;
  profileUrl: string;
  reason: string;
};

export type CzUsRosterImportResult = {
  seen: number;
  inserted: number;
  updated: number;
  portraitsStored: number;
  relinked: number;
  /** One entry per justice a run could not apply; never dropped silently. */
  failures: RosterImportFailure[];
};

export type CzUsRosterImportOptions = {
  store: CzUsRosterStore;
  fetch: RosterFetch;
  s3: RosterPortraitStore;
  now: () => Date;
  /** The gap left between two requests; a test pins it at zero. */
  intervalMs: number;
};

type PortraitBytes = ServedPortraitType & {
  bytes: Uint8Array;
  sha256: string;
};

const sha256Of = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

const orNull = (value: string | undefined): string | null => value ?? null;

/** One request to the court's site, checked against its origin and bounded. */
const readCourtSite = async (
  url: string,
  fetchImpl: RosterFetch,
): Promise<Result<Response, CzUsRosterFetchError>> => {
  const target = restrictOutboundUrl({
    hostPolicy: COURT_SITE_POLICY,
    rawUrl: url,
  });
  if (target === null) {
    return Result.err(
      new CzUsRosterFetchError({
        message: "link leaves the court's site",
        sourceUrl: url,
      }),
    );
  }
  return Result.ok(
    await fetchImpl(target.href, {
      headers: { "User-Agent": INGESTION_USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
  );
};

const readPortrait = async (
  url: string,
  fetchImpl: RosterFetch,
): Promise<Result<PortraitBytes, CzUsRosterFetchError>> => {
  const opened = await readCourtSite(url, fetchImpl);
  if (Result.isError(opened)) {
    return opened;
  }
  const response = opened.value;
  if (!response.ok) {
    return Result.err(
      new CzUsRosterFetchError({
        message: `portrait answered ${response.status}`,
        sourceUrl: url,
      }),
    );
  }
  const served = servedPortraitType(response.headers.get("content-type") ?? "");
  if (served === undefined) {
    return Result.err(
      new CzUsRosterFetchError({
        message: "portrait served an unsupported content type",
        sourceUrl: url,
      }),
    );
  }
  const bytes = await response.bytes();
  // The same ceiling the portrait route reads back with: storing a larger
  // object would put a portrait in the bucket that nothing can serve.
  if (bytes.byteLength > PORTRAIT_MAX_BYTES) {
    return Result.err(
      new CzUsRosterFetchError({
        message: `portrait is ${bytes.byteLength} bytes, past the ${PORTRAIT_MAX_BYTES}-byte ceiling`,
        sourceUrl: url,
      }),
    );
  }
  return Result.ok({ bytes, ...served, sha256: sha256Of(bytes) });
};

/** What the court now states about a row that already exists. */
const termPatch = (
  existing: StoredRosterJudge,
  page: ParsedJusticePage,
): RosterJudgePatch => ({
  ...(existing.fullName === page.fullName ? {} : { fullName: page.fullName }),
  ...(existing.termStart === orNull(page.termStart)
    ? {}
    : { termStart: orNull(page.termStart) }),
  ...(existing.termEnd === orNull(page.termEnd)
    ? {}
    : { termEnd: orNull(page.termEnd) }),
  ...(existing.externalRefs.sourceUrl === page.sourceUrl
    ? {}
    : {
        externalRefs: {
          ...existing.externalRefs,
          sourceUrl: page.sourceUrl,
        },
      }),
});

type JusticeOutcome = {
  inserted: boolean;
  updated: boolean;
  portraitStored: boolean;
};

type ApplyJusticeOptions = {
  entry: RosterListingEntry;
  nameKey: string;
  store: CzUsRosterStore;
  fetchImpl: RosterFetch;
  s3: RosterPortraitStore;
  now: () => Date;
};

const applyJustice = async ({
  entry,
  nameKey,
  store,
  fetchImpl,
  s3,
  now,
}: ApplyJusticeOptions): Promise<
  Result<JusticeOutcome, CzUsRosterFetchError | CzUsRosterParseError>
> => {
  const profile = await readCourtSite(entry.profileUrl, fetchImpl);
  if (Result.isError(profile)) {
    return profile;
  }
  const response = profile.value;
  if (!response.ok) {
    return Result.err(
      new CzUsRosterFetchError({
        message: `justice page answered ${response.status}`,
        sourceUrl: entry.profileUrl,
      }),
    );
  }
  const parsed = parseJusticePage({
    html: await response.text(),
    sourceUrl: entry.profileUrl,
  });
  if (Result.isError(parsed)) {
    return parsed;
  }
  const page = parsed.value;
  const found = await store.findByNameKey(nameKey);
  // The row exists before its portrait does: a run interrupted between the
  // two leaves a row without one, which the next run stores. The reverse
  // order would leave a stored object that no row names.
  const opened =
    found === undefined
      ? await insertJusticeRow({ nameKey, page, store })
      : { row: found, inserted: false };
  const stored = opened.row;
  const termChanges = found === undefined ? {} : termPatch(found, page);
  let portrait: PortraitBytes | undefined;
  if (page.portraitUrl !== undefined) {
    const read = await readPortrait(page.portraitUrl, fetchImpl);
    if (Result.isError(read)) {
      return read;
    }
    portrait = read.value;
  }
  const refs = { ...stored.externalRefs, ...termChanges.externalRefs };
  const portraitChanges =
    portrait !== undefined &&
    (refs.portraitSha256 !== portrait.sha256 || stored.portraitS3Key === null)
      ? await storePortrait({ judgeId: stored.id, portrait, refs, s3 })
      : {};
  const patch = { ...termChanges, ...portraitChanges };
  if (Object.keys(patch).length > 0) {
    // The column has a default but no update trigger, so a row's freshness is
    // whatever its last writer stated.
    await store.updateJudge({
      id: stored.id,
      patch: { ...patch, updatedAt: now() },
    });
  }
  return Result.ok({
    inserted: opened.inserted,
    // A fresh row's portrait is part of inserting it, not an update on top.
    updated: !opened.inserted && Object.keys(patch).length > 0,
    portraitStored: Object.keys(portraitChanges).length > 0,
  });
};

const insertJusticeRow = async ({
  nameKey,
  page,
  store,
}: {
  nameKey: string;
  page: ParsedJusticePage;
  store: CzUsRosterStore;
}): Promise<{ row: StoredRosterJudge; inserted: boolean }> => {
  const fresh: NewRosterJudge = {
    id: createSafeId<"caseLawJudge">(),
    fullName: page.fullName,
    nameKey,
    termStart: orNull(page.termStart),
    termEnd: orNull(page.termEnd),
    externalRefs: { sourceUrl: page.sourceUrl },
  };
  const { id, inserted } = await store.insertJudge(fresh);
  if (inserted) {
    return { row: { ...fresh, id, portraitS3Key: null }, inserted };
  }
  // Another run holds the key. What it wrote, not what this run would have
  // written, is what the rest of the pass compares against.
  const held =
    (await store.findByNameKey(nameKey)) ??
    panic(`roster key ${nameKey} refused an insert but holds no row`);
  return { row: held, inserted };
};

const storePortrait = async ({
  judgeId,
  portrait,
  refs,
  s3,
}: {
  judgeId: CaseLawJudgeId;
  portrait: PortraitBytes;
  refs: JudgeExternalRefs;
  s3: RosterPortraitStore;
}): Promise<RosterJudgePatch> => {
  const key = `${PORTRAIT_KEY_PREFIX}${judgeId}.${portrait.extension}`;
  await s3.put({
    key,
    bytes: portrait.bytes,
    contentType: portrait.contentType,
  });
  return {
    externalRefs: { ...refs, portraitSha256: portrait.sha256 },
    portraitS3Key: key,
    portraitSource: PORTRAIT_SOURCE.COURT_OFFICIAL,
    portraitAttribution: PORTRAIT_ATTRIBUTION,
    portraitContentType: portrait.contentType,
  };
};

/**
 * Fetch both listings, follow every justice's link, and bring
 * `case_law_judges` up to what the court states.
 *
 * A listing that does not answer 2xx halts the run: the rest of the roster is
 * unknown, and a partial listing read as complete would leave the rows it
 * omits looking current. One justice's page failing is terminal for that
 * justice alone and is returned in `failures`.
 *
 * Re-running is a fixed point. A row is written only where the court's
 * statement differs from the stored one, and a portrait is transferred only
 * where its bytes hash differently from the hash the row carries.
 */
export const importCzUsRoster = async ({
  store,
  fetch: fetchImpl,
  s3,
  now,
  intervalMs,
}: CzUsRosterImportOptions): Promise<
  Result<CzUsRosterImportResult, CzUsRosterFetchError | CzUsRosterListingError>
> => {
  const startedAt = now();
  const paced: RosterFetch = async (url, init) => {
    if (intervalMs > 0) {
      await Bun.sleep(intervalMs);
    }
    return await fetchImpl(url, init);
  };
  const result: CzUsRosterImportResult = {
    seen: 0,
    inserted: 0,
    updated: 0,
    portraitsStored: 0,
    relinked: 0,
    failures: [],
  };
  const applied = new Set<string>();

  for (const listingUrl of CZ_US_ROSTER_LISTINGS) {
    const opened = await readCourtSite(listingUrl, paced);
    if (Result.isError(opened)) {
      return opened;
    }
    const response = opened.value;
    if (!response.ok) {
      return Result.err(
        new CzUsRosterListingError({
          message: `roster listing answered ${response.status}`,
          httpStatus: response.status,
          listingUrl,
        }),
      );
    }
    const entries = parseRosterListing({
      html: await response.text(),
      listingUrl,
    });
    for (const entry of entries) {
      const nameKey = judgeNameKey(entry.name);
      // The listings overlap: one person can be printed on both, and the
      // sitting listing is read first, so the first statement of a key wins.
      if (applied.has(nameKey)) {
        continue;
      }
      applied.add(nameKey);
      result.seen += 1;
      // The store and the object bucket report failure by rejecting, so the
      // attempt is wrapped as well as returned. Either way one justice is
      // terminal for that justice alone and the rest of the roster follows.
      const attempted = await Result.tryPromise(
        async () =>
          await applyJustice({
            entry,
            nameKey,
            store,
            fetchImpl: paced,
            s3,
            now,
          }),
      );
      const outcome = Result.flatten(attempted);
      if (Result.isError(outcome)) {
        const reason = outcome.error.message;
        result.failures.push({
          name: entry.name,
          profileUrl: entry.profileUrl,
          reason,
        });
        // `judgeKey`, not `nameKey`: the logger drops attribute keys that
        // read as free text before they are shipped.
        logger.error("case_law.judge_roster_entry_failed", {
          country: CZ_US_COUNTRY,
          court: CZ_US_COURT,
          judgeKey: nameKey,
          reason,
        });
        continue;
      }
      result.inserted += outcome.value.inserted ? 1 : 0;
      result.updated += outcome.value.updated ? 1 : 0;
      result.portraitsStored += outcome.value.portraitStored ? 1 : 0;
    }
  }

  result.relinked = await store.relinkUnmatched();
  logger.info("case_law.judge_roster_imported", {
    country: CZ_US_COUNTRY,
    court: CZ_US_COURT,
    durationMs: now().getTime() - startedAt.getTime(),
    seen: result.seen,
    inserted: result.inserted,
    updated: result.updated,
    portraitsStored: result.portraitsStored,
    relinked: result.relinked,
    failed: result.failures.length,
  });
  return Result.ok(result);
};

/* -- production wiring --------------------------------------------------- */

const rosterKey = (nameKey: string) =>
  and(
    eq(caseLawJudges.country, CZ_US_COUNTRY),
    eq(caseLawJudges.court, CZ_US_COURT),
    eq(caseLawJudges.nameKey, nameKey),
  );

const ROSTER_COLUMNS = {
  id: caseLawJudges.id,
  fullName: caseLawJudges.fullName,
  termStart: caseLawJudges.termStart,
  termEnd: caseLawJudges.termEnd,
  externalRefs: caseLawJudges.externalRefs,
  portraitS3Key: caseLawJudges.portraitS3Key,
} as const;

/**
 * The roster store against the ingestion role's transaction runner: the role
 * the corpus tables grant writes to, one short transaction per operation, so
 * no lock is held while the court's site answers.
 */
export const czUsRosterStore = (
  ingestionDb: CaseLawIngestionHandle,
): CzUsRosterStore => {
  const findByNameKey = async (
    nameKey: string,
  ): Promise<StoredRosterJudge | undefined> =>
    await ingestionDb(async (tx) =>
      (
        await tx
          .select(ROSTER_COLUMNS)
          .from(caseLawJudges)
          .where(rosterKey(nameKey))
          .limit(1)
      ).at(0),
    );

  return {
    findByNameKey,
    insertJudge: async (judge) => {
      const inserted = await ingestionDb(async (tx) => {
        // audit: skip — public corpus roster, imported by an operator pass
        // with no workspace actor to attribute the row to
        const written = await tx
          .insert(caseLawJudges)
          .values({
            ...judge,
            country: CZ_US_COUNTRY,
            court: CZ_US_COURT,
          })
          .onConflictDoNothing()
          .returning({ id: caseLawJudges.id });
        return written.at(0);
      });
      if (inserted !== undefined) {
        return { id: inserted.id, inserted: true };
      }
      const held =
        (await findByNameKey(judge.nameKey)) ??
        panic(`roster key ${judge.nameKey} refused an insert but holds no row`);
      return { id: held.id, inserted: false };
    },
    updateJudge: async ({ id, patch }) => {
      await ingestionDb(async (tx) => {
        // audit: skip — as above; the row's own `updated_at` is its trail
        await tx
          .update(caseLawJudges)
          .set(patch)
          .where(eq(caseLawJudges.id, id));
      });
    },
    relinkUnmatched: async () =>
      (
        await ingestionDb(
          async (tx) =>
            await relinkUnmatchedDecisionJudges(tx, {
              country: CZ_US_COUNTRY,
              court: CZ_US_COURT,
            }),
        )
      ).linked,
  };
};

/**
 * The legal-corpus bucket, reached on first use so that importing this module
 * resolves no credentials.
 */
export const corpusPortraitStore: RosterPortraitStore = {
  put: async ({ key, bytes, contentType }) => {
    const { putCorpusS3ObjectWithSignal } = await import("@/api/lib/s3");
    await putCorpusS3ObjectWithSignal(
      key,
      bytes,
      contentType,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    );
  },
};

if (import.meta.main) {
  // The maintenance lane is the door an operator pass takes to the case-law
  // tables and it holds a connection for the life of the process, so only a
  // direct run opens one.
  const { enterCaseLawMaintenanceLane } =
    await import("@/api/lib/case-law/maintenance-lane");
  const { ingestionDb } = await enterCaseLawMaintenanceLane();
  const imported = await importCzUsRoster({
    store: czUsRosterStore(ingestionDb),
    fetch: globalThis.fetch,
    s3: corpusPortraitStore,
    now: () => new Date(),
    intervalMs: CZ_US_ROSTER_REQUEST_INTERVAL_MS,
  });
  if (Result.isError(imported)) {
    process.stderr.write(`${imported.error.message}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(imported.value, null, 2)}\n`);
  process.exit(imported.value.failures.length === 0 ? 0 : 1);
}
