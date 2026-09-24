/**
 * pl-uodo against records the portal actually served.
 *
 * The listing fixture is one decision year captured verbatim through the
 * reconciliation's own request: the authority's decisions, the administrative
 * courts' rulings on them, and the legislation and guidance the portal files
 * beside them. The body fixture is the XML the portal served for one of those
 * decisions. The crawl is driven against a model of the search built over the
 * captured records, honouring the same keyset, offset and order parameters.
 */

import { panic, Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import {
  decodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import {
  assemblePlUodoDecision,
  classifyPlUodoRow,
  encodePlUodoCursor,
  listPlUodoSourceFields,
  nextPlUodoCursor,
  normalizePlUodoRow,
  parsePlUodoCursor,
  PL_UODO_BODY_STATUS,
  PL_UODO_SKIP_REASON,
  plUodoAdapter,
  plUodoBodyFrom,
  plUodoDocketOfCourtUrn,
  plUodoListingIdentity,
  plUodoRawPartsOf,
  tallyPlUodoSkips,
} from "@/api/handlers/case-law/ingestion/adapters/pl-uodo";
import { DECISION_JUDGE_ROLE } from "@/api/handlers/case-law/judges/consts";
import { readGzipJson } from "@/api/lib/gzip-json";
import { isRecord } from "@/api/lib/type-guards";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const LISTING_FIXTURE = new URL(
  "__fixtures__/pl-uodo-listing-2023.json.gz",
  import.meta.url,
);

const BODY_FIXTURE = new URL(
  "../parsers/__fixtures__/pl-uodo-dkn-5131-45-2022.xml",
  import.meta.url,
);

/** A decision the listing links to the ruling on its appeal. */
const DECISION_URN = "urn:ndoc:gov:pl:uodo:2022:dkn_5131_45";

/** That ruling, filed in the same year. */
const RULING_URN = "urn:ndoc:court:pl:sa:2023:ii_sa-wa_996";

const listingRecords = async (): Promise<Record<string, unknown>[]> => {
  const listed = await readGzipJson(LISTING_FIXTURE);
  const records: unknown[] = Array.isArray(listed) ? listed : [];
  return records.filter(isRecord);
};

const recordOf = async (urn: string): Promise<Record<string, unknown>> =>
  (await listingRecords()).find((record) => record["refid"] === urn) ??
  panic(`the listing fixture lost ${urn}`);

const bodyBytes = async (): Promise<Uint8Array> =>
  new Uint8Array(await Bun.file(BODY_FIXTURE).arrayBuffer());

const buildFrom = (
  listing: Record<string, unknown>,
  bytes: Uint8Array | undefined,
) => {
  const row = normalizePlUodoRow(listing);
  const body = bytes === undefined ? undefined : plUodoBodyFrom(row, bytes);
  return assemblePlUodoDecision({
    row,
    body,
    rawParts: plUodoRawPartsOf(listing, body),
  });
};

const builtDecision = (
  built: ReturnType<typeof assemblePlUodoDecision>,
): IngestionResult =>
  built.type === "built" || built.type === "detail-unavailable"
    ? built.decision
    : panic(`expected a decision, got ${built.type}`);

const originalFetch = globalThis.fetch;
const originalSleep = Bun.sleep;

/** The UTC day a crawl run now parks on. */
const todayUtc = (): string => new Date().toISOString().slice(0, 10);

/** A parked cursor moved back to a day that has closed. */
const parkedYesterday = (cursor: string | null): string => {
  const parsed = parsePlUodoCursor(cursor);
  const yesterday = new Date(Date.now() - 86_400_000)
    .toISOString()
    .slice(0, 10);
  return encodePlUodoCursor({ ...parsed, parkedOn: yesterday });
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  Bun.sleep = originalSleep;
});

// ── A model of the portal's search ───────────────────────

type ServedRequest = { url: URL };

type PortalModel = {
  records: Record<string, unknown>[];
  bodies: ReadonlyMap<string, Uint8Array>;
  requests: ServedRequest[];
  /** How every body request is answered, in place of `bodies`. */
  bodyAnswer?: (() => Response) | undefined;
};

const epochOf = (value: unknown): number =>
  typeof value === "string" ? Date.parse(value) : Number.NaN;

const compareBy =
  (keys: readonly string[]) =>
  (left: Record<string, unknown>, right: Record<string, unknown>): number => {
    for (const key of keys) {
      const a = key === "mtime" ? epochOf(left[key]) : String(left[key]);
      const b = key === "mtime" ? epochOf(right[key]) : String(right[key]);
      if (a < b) {
        return -1;
      }
      if (a > b) {
        return 1;
      }
    }
    return 0;
  };

const SEARCH_PREFIX = "/api/documents/search/PublicDocument/";
const EVENTS_PREFIX = "/api/documents/events/";

/**
 * What Bun's fetch does with a redirect under `redirect: "error"`: it refuses
 * it with a `TypeError` whose `code` names the refusal, and reports no status.
 */
const refusingRedirects = async (
  response: Response,
  init: RequestInit | undefined,
): Promise<Response> =>
  response.status >= 300 && response.status < 400 && init?.redirect === "error"
    ? await Promise.reject(
        Object.assign(new TypeError("UnexpectedRedirect fetching"), {
          code: "UnexpectedRedirect",
        }),
      )
    : response;

/**
 * One `index:op:value` condition, for the indexes and operators this adapter
 * asks with: `mtime` compared as the portal's millisecond integer, `id` as
 * text. A condition the model does not know fails the test rather than
 * matching everything.
 */
const satisfies = (
  record: Record<string, unknown>,
  condition: string,
): boolean => {
  const [index = "", op = "", ...rest] = condition.split(":");
  const value = rest.join(":");
  const compare = (left: number | string, right: number | string): number => {
    if (left < right) {
      return -1;
    }
    return left > right ? 1 : 0;
  };
  const orderOf = (): number => {
    if (index === "mtime") {
      return compare(epochOf(record["mtime"]), Number(value));
    }
    if (index === "id") {
      return compare(String(record["id"]), value);
    }
    return panic(`the portal model knows no index ${index}`);
  };
  const order = orderOf();
  switch (op) {
    case "ge":
      return order >= 0;
    case "gt":
      return order > 0;
    case "eq":
      return order === 0;
    default:
      return panic(`the portal model knows no operator ${op}`);
  }
};

/**
 * A record as `fields` projects it: `*` is the index record without `mtime`,
 * which only comes when named, and a list names the keys to keep.
 */
const projected = (
  record: Record<string, unknown>,
  fields: string | null,
): Record<string, unknown> => {
  const names = (fields ?? "*").split(",");
  const kept = Object.entries(record).filter(
    ([key]) => names.includes(key) || (names.includes("*") && key !== "mtime"),
  );
  return Object.fromEntries(kept);
};

/**
 * Answers the search the way the portal does for the parameters this adapter
 * sends: an inclusive decision-date timespan, an `mtime:ge:` keyset, `order`
 * over `mtime` and `id` ascending, then `from` and `count`. A body request is
 * answered from `bodies` by event id, and with 404 for any other.
 */
const answerPortal = async (
  model: PortalModel,
  input: string | URL | Request,
): Promise<Response> => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  model.requests.push({ url });
  if (url.pathname.startsWith(EVENTS_PREFIX)) {
    if (model.bodyAnswer !== undefined) {
      return await Promise.resolve(model.bodyAnswer());
    }
    const [eventId] = url.pathname.slice(EVENTS_PREFIX.length).split("/");
    const body = model.bodies.get(eventId ?? "");
    return await Promise.resolve(
      body === undefined
        ? new Response("Nie znaleziono", { status: 404 })
        : new Response(body, {
            headers: { "Content-Type": "application/xml" },
          }),
    );
  }
  const [timespan = ",", ...conditions] = decodeURIComponent(
    url.pathname.slice(SEARCH_PREFIX.length),
  ).split("/");
  const [fromDay = "", toDay = ""] = timespan.split(",");
  const order = (url.searchParams.get("order") ?? "")
    .split(",")
    .filter((key) => key.length > 0)
    .map((key) => key.replace(/^[+]/u, ""));
  const matched = model.records
    .filter((record) => {
      const day = String(record["time"]).slice(0, 10);
      return (
        (fromDay === "" || day >= fromDay) && (toDay === "" || day <= toDay)
      );
    })
    .filter((record) =>
      conditions.every((condition) => satisfies(record, condition)),
    )
    .toSorted(compareBy(order));
  const from = Number(url.searchParams.get("from") ?? "0");
  const count = Number(url.searchParams.get("count") ?? "100");
  const fields = url.searchParams.get("fields");
  return await Promise.resolve(
    new Response(
      JSON.stringify(
        matched
          .slice(from, from + count)
          .map((record) => projected(record, fields)),
      ),
      { headers: { "Content-Type": "application/json" } },
    ),
  );
};

const servePortal = (model: PortalModel): void => {
  globalThis.fetch = asFetchMock(
    async (input: string | URL | Request, init?: RequestInit) =>
      await refusingRedirects(await answerPortal(model, input), init),
  );
};

const portalOverFixtures = async (): Promise<PortalModel> => {
  const records = await listingRecords();
  const decision = normalizePlUodoRow(await recordOf(DECISION_URN));
  return {
    records,
    bodies: new Map([[decision.id ?? "", await bodyBytes()]]),
    requests: [],
  };
};

/** The identities a set of decisions is stored under. */
const urnsOf = (decisions: readonly IngestionResult[]): string[] =>
  decisions.map(({ sourceDocumentId }) => sourceDocumentId ?? "");

/** A copy of a record with one field restated. */
const withField = (
  record: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> => ({ ...record, [key]: value });

/** Every in-scope URN of a set of records, as the crawl should store them. */
const inScopeUrns = (records: readonly Record<string, unknown>[]): string[] =>
  records
    .map(normalizePlUodoRow)
    .filter((row) => classifyPlUodoRow(row).type !== "skipped")
    .map((row) => row.refid ?? "")
    .toSorted();

type Walk = { decisions: IngestionResult[]; cursors: string[] };

/** Crawl from `cursor` until the adapter parks, as the pipeline would. */
const walkCrawl = async (
  cursor: string | null,
  maxPages = 50,
): Promise<Walk> => {
  const decisions: IngestionResult[] = [];
  const cursors: string[] = [];
  let current = cursor;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await plUodoAdapter.fetchPage(current, {});
    if (Result.isError(result)) {
      throw result.error;
    }
    decisions.push(...result.value.decisions);
    const next = result.value.nextCursor ?? panic("the crawl restarted");
    cursors.push(next);
    if (next === current) {
      return { decisions, cursors };
    }
    current = next;
  }
  return panic("the crawl never parked");
};

// ── What a record is ─────────────────────────────────────

describe("classifying the portal's records", () => {
  test("a decision year holds decisions, court rulings, and records left out by reason", async () => {
    const rows = (await listingRecords()).map(normalizePlUodoRow);
    const classes = rows.map((row) => classifyPlUodoRow(row).type);

    expect(
      classes.filter((type) => type === "authority-decision"),
    ).toHaveLength(43);
    expect(classes.filter((type) => type === "court-ruling")).toHaveLength(16);
    // Three CJEU judgments as the EU journal prints them, a regulation from
    // the Polish journal, and the EDPB's guidelines.
    expect(tallyPlUodoSkips(rows)).toEqual({
      [PL_UODO_SKIP_REASON.RULING_IN_JOURNAL]: 3,
      [PL_UODO_SKIP_REASON.LEGISLATION]: 1,
      [PL_UODO_SKIP_REASON.OTHER_AUTHORITY]: 1,
    });
  });

  test("every administrative-court record is filed under the court that decided it", async () => {
    const courts = (await listingRecords())
      .map(normalizePlUodoRow)
      .flatMap((row) => {
        const recordClass = classifyPlUodoRow(row);
        return recordClass.type === "court-ruling"
          ? [recordClass.court.name]
          : [];
      });

    expect(new Set(courts)).toEqual(
      new Set([
        "Naczelny Sąd Administracyjny",
        "Wojewódzki Sąd Administracyjny w Warszawie",
      ]),
    );
  });

  test("court names the record abbreviates resolve to the court's own name", () => {
    const courtOf = (subtype: string, name: string) => {
      const recordClass = classifyPlUodoRow(
        normalizePlUodoRow({
          refid: "urn:ndoc:court:pl:sa:2004:iv_sa_1",
          name: { pl: name },
          publicator: { type: "court", subtype, country: "pl" },
        }),
      );
      return recordClass.type === "court-ruling" ? recordClass.court : null;
    };

    expect(
      courtOf("sa", "Wyrok - Wojewódzki Sąd Administracyjny w Gorzowie Wlkp."),
    ).toMatchObject({
      name: "Wojewódzki Sąd Administracyjny w Gorzowie Wielkopolskim",
      level: "regional-administrative",
    });
    expect(
      courtOf("sa", "Wyrok - NSA w Warszawie (przed reformą)"),
    ).toMatchObject({ name: "Naczelny Sąd Administracyjny", era: "pre-2004" });
    expect(courtOf("sa", "Wyrok - NSA oz. w Gdańsku")).toMatchObject({
      name: "Naczelny Sąd Administracyjny",
      branch: "Ośrodek Zamiejscowy w Gdańsku",
    });
    expect(
      courtOf("sp", "Wyrok z uzasadnieniem - Sąd Rejonowy w Puławach"),
    ).toMatchObject({ name: "Sąd Rejonowy w Puławach", level: "common" });
    expect(
      courtOf("sn", "Wyrok Sądu Najwyższego z dnia 20 kwietnia 2011 r."),
    ).toMatchObject({ name: "Sąd Najwyższy", level: "supreme" });
  });

  test("a court record naming no court this adapter knows is left out, not filed under a guess", () => {
    expect(
      classifyPlUodoRow(
        normalizePlUodoRow({
          name: { pl: "Wyrok - Sąd Wojskowy w Warszawie" },
          publicator: { type: "court", subtype: "sp", country: "pl" },
        }),
      ),
    ).toEqual({
      type: "skipped",
      reason: PL_UODO_SKIP_REASON.UNRECOGNISED_COURT,
    });
  });

  test("legislation builds to nothing, and says why", async () => {
    const regulation = await recordOf("urn:ndoc:pro:pl:durp:2023:1368");
    expect(buildFrom(regulation, undefined)).toEqual({
      type: "skipped",
      reason: PL_UODO_SKIP_REASON.LEGISLATION,
    });
  });
});

// ── An authority decision ────────────────────────────────

describe("an authority decision", () => {
  test("is stored under the authority with its body parsed and both responses kept", async () => {
    const decision = builtDecision(
      buildFrom(await recordOf(DECISION_URN), await bodyBytes()),
    );

    expect(decision).toMatchObject({
      sourceDocumentId: DECISION_URN,
      caseNumber: "DKN.5131.45.2022",
      court: "Prezes Urzędu Ochrony Danych Osobowych",
      country: "POL",
      language: "pl",
      decisionDate: "2023-03-14",
      decisionType: "decyzja",
      sourceUrl: `https://orzeczenia.uodo.gov.pl/document/${DECISION_URN}/content`,
      documentUrl: `https://orzeczenia.uodo.gov.pl/api/documents/public/items/${DECISION_URN}:0/body.pdf`,
      sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    });
    expect(decision.isListingOnly).toBeUndefined();
    expect(decision.fulltext).toContain(
      "W tym stanie faktycznym i prawnym Prezes Urzędu Ochrony Danych Osobowych rozstrzygnął, jak w sentencji.",
    );
    expect(decision.textFields.summary.type).toBe("present");
    expect(
      Object.keys(decodeSourceRawEnvelope(decision.sourceRaw ?? "") ?? {}),
    ).toEqual(["listing", "body-xml"]);
    // The served bytes are the ones the record's checksum names.
    expect(decision.metadata["bodyChecksumMismatch"]).toBeUndefined();
  });

  test("a body that is not the one the record's checksum names is kept and flagged", async () => {
    const served = await bodyBytes();
    const altered = new Uint8Array([...served, 0x20]);
    const decision = builtDecision(
      buildFrom(await recordOf(DECISION_URN), altered),
    );
    expect(decision.metadata["bodyChecksumMismatch"]).toBe(true);
    expect(decision.fulltext).toBeDefined();
  });

  test("the portal serving no body leaves a record-only row, never nothing", async () => {
    const built = buildFrom(await recordOf(DECISION_URN), undefined);
    expect(built.type).toBe("detail-unavailable");
    expect(builtDecision(built)).toMatchObject({
      sourceDocumentId: DECISION_URN,
      isListingOnly: true,
    });
  });

  test("its appeal is kept as a link to the ruling's own identity in this source", async () => {
    const decision = builtDecision(
      buildFrom(await recordOf(DECISION_URN), await bodyBytes()),
    );
    const ruling = builtDecision(
      buildFrom(await recordOf(RULING_URN), undefined),
    );

    expect(decision.metadata["linkedRulings"]).toEqual([
      {
        relation: "defended",
        date: "2023-11-06",
        status: "nonfinal",
        scope: "*",
        text: undefined,
        sourceDocumentId: RULING_URN,
        caseNumber: "II SA/Wa 996/23",
      },
    ]);
    // The link names the ruling the way this source stores it, so the two
    // rows meet on the ruling's identity and on its docket.
    expect(ruling.sourceDocumentId).toBe(RULING_URN);
    expect(ruling.caseNumber).toBe("II SA/Wa 996/23");
  });

  test("the rulings and decisions it cites are the publisher's cited-cases list", async () => {
    const decision = builtDecision(
      buildFrom(await recordOf(DECISION_URN), await bodyBytes()),
    );
    expect(decision.publisherCitedCases).toContain("II SA/Wa 791/21");
    expect(decision.publisherCitedCases).toContain("I C 566/15");
  });
});

// ── A court ruling ───────────────────────────────────────

describe("a court ruling the portal files", () => {
  test("is stored under its court with the key the courts' database keys it by", async () => {
    const ruling = builtDecision(
      buildFrom(await recordOf(RULING_URN), undefined),
    );

    expect(ruling).toMatchObject({
      sourceDocumentId: RULING_URN,
      court: "Wojewódzki Sąd Administracyjny w Warszawie",
      caseNumber: "II SA/Wa 996/23",
      decisionDate: "2023-11-06",
      decisionType: "wyrok",
    });
    // No text and no later fetch: the ordinary no-document path, which the
    // pipeline stores unpublished.
    expect(ruling.documentDelivery).toBeUndefined();
    expect(ruling.fulltext).toBeUndefined();
    expect(ruling.documentAst).toEqual({});
    expect(ruling.metadata["crossSourceKey"]).toEqual({
      court: "Wojewódzki Sąd Administracyjny w Warszawie",
      caseNumber: "II SA/Wa 996/23",
      decisionDate: "2023-11-06",
      decisionType: "wyrok",
      cbosaDocumentId: "CB7D6E6DEE",
    });
  });

  test("names its bench by the functions the record prints", async () => {
    const ruling = builtDecision(
      buildFrom(await recordOf(RULING_URN), undefined),
    );
    const roles = (ruling.judges ?? []).map(({ role }) => role);

    expect(
      roles.filter((role) => role === DECISION_JUDGE_ROLE.PANEL_MEMBER),
    ).toHaveLength(3);
    expect(
      roles.filter((role) => role === DECISION_JUDGE_ROLE.PRESIDING),
    ).toHaveLength(1);
    expect(
      roles.filter((role) => role === DECISION_JUDGE_ROLE.RAPPORTEUR),
    ).toHaveLength(1);
  });

  test("records the portal spells unevenly still key and file correctly", () => {
    const ruling = (record: Record<string, unknown>) =>
      builtDecision(
        buildFrom(
          {
            publicator: { type: "court", subtype: "sa", country: "pl" },
            time: "2021-01-01T00:00:00.000Z",
            ...record,
          },
          undefined,
        ),
      );

    // A seat with a Polish letter in its URN.
    expect(
      ruling({
        refid: "urn:ndoc:court:pl:sa:2024:iii_sa-łd_147",
        refname: "III SA/Łd 147/24",
        kind: "Wyrok",
        name: { pl: "Wyrok - Wojewódzki Sąd Administracyjny w Łodzi" },
      }),
    ).toMatchObject({
      sourceDocumentId: "urn:ndoc:court:pl:sa:2024:iii_sa-łd_147",
      caseNumber: "III SA/Łd 147/24",
    });
    // A docket typed with dashes: the URN states it.
    expect(
      ruling({
        refid: "urn:ndoc:court:pl:sa:2020:ii_sa-wa_609",
        refname: "II SA-Wa 609-20",
        kind: "Wyrok",
        name: { pl: "Wyrok - Wojewódzki Sąd Administracyjny w Warszawie" },
      }),
    ).toMatchObject({
      caseNumber: "II SA/Wa 609/20",
      metadata: { docketAsPrinted: "II SA-Wa 609-20", docketRecognised: true },
    });
    // A record with no kind, whose name opens on the separator.
    expect(
      ruling({
        refid: "urn:ndoc:court:pl:sa:1998:iv_sa_2543",
        refname: "IV SA 2543/98",
        kind: "",
        name: { pl: " - NSA w Warszawie (przed reformą)" },
      }),
    ).toMatchObject({
      court: "Naczelny Sąd Administracyjny",
      caseNumber: "IV SA 2543/98",
      decisionType: undefined,
      metadata: { courtEra: "pre-2004" },
    });
  });

  test("the docket a court URN encodes is the docket the record states", async () => {
    const pairs = (await listingRecords())
      .map(normalizePlUodoRow)
      .filter((row) => row.publicator.subtype === "sa")
      .map((row) => [plUodoDocketOfCourtUrn(row.refid ?? ""), row.refname]);
    const derived = pairs.filter(([fromUrn]) => fromUrn !== null);

    // One URN encodes a sitting date the docket does not, and is left
    // unread rather than guessed at.
    expect(derived.length).toBe(pairs.length - 1);
    for (const [fromUrn, stated] of derived) {
      expect(fromUrn).toBe(stated);
    }
    expect(
      plUodoDocketOfCourtUrn("urn:ndoc:court:pl:sa:2019:ii_sab-wa_103"),
    ).toBe("II SAB/Wa 103/19");
  });
});

// ── Identity ─────────────────────────────────────────────

describe("identity", () => {
  test("is the document URN, the same for the crawl, the reconciliation and the stored row", async () => {
    for (const listing of await listingRecords()) {
      const row = normalizePlUodoRow(listing);
      if (classifyPlUodoRow(row).type === "skipped") {
        continue;
      }
      const identity = plUodoListingIdentity(row);
      const decision = builtDecision(buildFrom(listing, undefined));
      expect(identity).toEqual({
        type: "document",
        sourceDocumentId: row.refid ?? "",
      });
      expect(decision.sourceDocumentId).toBe(row.refid);
    }
  });

  test("does not move when the portal re-issues the record under a new event", async () => {
    const listing = await recordOf(DECISION_URN);
    const reissued = {
      ...listing,
      id: "PublicDocument-20260101-000000-000-00000000000000000000000000000000",
      mtime: "2026-01-01T00:00:00.000Z",
    };
    const first = builtDecision(buildFrom(listing, undefined));
    const second = builtDecision(buildFrom(reissued, undefined));

    expect(second.sourceDocumentId).toBe(first.sourceDocumentId);
    // The record changed, so the observation is a new one.
    expect(second.rawHash).not.toBe(first.rawHash);
    expect(builtDecision(buildFrom(listing, undefined)).rawHash).toBe(
      first.rawHash,
    );
  });

  test("counts exactly the court rulings as held on their record alone", async () => {
    const { heldWithoutDetail } = plUodoAdapter.reconciliation;
    expect(plUodoAdapter.reconciliation.heldRequiresDetail).toBe(true);
    for (const listing of await listingRecords()) {
      const row = normalizePlUodoRow(listing);
      const recordClass = classifyPlUodoRow(row).type;
      if (recordClass === "skipped") {
        continue;
      }
      expect(heldWithoutDetail?.(plUodoListingIdentity(row)), row.refid).toBe(
        recordClass === "court-ruling",
      );
    }
  });

  test("a record with no URN in the portal's form is unkeyable", () => {
    const row = normalizePlUodoRow({
      refid: "../../etc",
      publicator: { type: "gov", subtype: "uodo" },
    });
    expect(plUodoListingIdentity(row)).toEqual({ type: "unidentifiable" });
  });

  test("a stored envelope replays into the decision the crawl built", async () => {
    const decision = builtDecision(
      buildFrom(await recordOf(DECISION_URN), await bodyBytes()),
    );
    const replayed = await plUodoAdapter.reparseStoredRaw?.({
      raw: new TextEncoder().encode(decision.sourceRaw ?? ""),
      contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      caseNumber: decision.caseNumber,
      sourceDocumentId: decision.sourceDocumentId ?? null,
      language: decision.language,
      court: decision.court,
      ecli: null,
      decisionDate: decision.decisionDate ?? null,
      decisionType: decision.decisionType ?? null,
      sourceUrl: decision.sourceUrl ?? null,
      documentUrl: decision.documentUrl ?? null,
      metadata: decision.metadata,
    });

    expect(replayed?.type).toBe("parsed");
    if (replayed?.type !== "parsed") {
      return;
    }
    expect(replayed.result.rawHash).toBe(decision.rawHash);
    expect(replayed.result.fulltext).toBe(decision.fulltext);
    expect(replayed.result.metadata).toEqual(decision.metadata);
  });
});

// ── The crawl ────────────────────────────────────────────

describe("the crawl over modification time", () => {
  test("reads every record once and parks past the last", async () => {
    const model = await portalOverFixtures();
    servePortal(model);

    const { cursors, decisions } = await walkCrawl(null);
    const stored = urnsOf(decisions);

    expect(stored.toSorted()).toEqual(inScopeUrns(model.records));
    expect(new Set(stored).size).toBe(stored.length);
    // Only the decision with a captured body carries one; the others are
    // record-only rows, which the reconciliation hunts again.
    expect(
      decisions
        .filter(({ fulltext }) => fulltext !== undefined)
        .map(({ sourceDocumentId }) => sourceDocumentId),
    ).toEqual([DECISION_URN]);

    const lastModified = Math.max(
      ...model.records.map((record) => epochOf(record["mtime"])),
    );
    const lastId = model.records.find(
      (record) => epochOf(record["mtime"]) === lastModified,
    )?.["id"];
    // Parked at the last record read, on the day the lap reached the tip.
    expect(parsePlUodoCursor(cursors.at(-1) ?? null)).toEqual({
      mtimeMs: lastModified,
      afterId: typeof lastId === "string" ? lastId : undefined,
      parkedOn: todayUtc(),
    });
  });

  test("a quiet cycle on the day the crawl parked makes no request and returns its cursor", async () => {
    const model = await portalOverFixtures();
    servePortal(model);
    const { cursors } = await walkCrawl(null);
    const parked = cursors.at(-1) ?? null;
    model.requests.length = 0;

    const again = await plUodoAdapter.fetchPage(parked, {});
    expect(Result.isOk(again) && again.value).toEqual({
      decisions: [],
      nextCursor: parked,
    });
    expect(model.requests).toEqual([]);
  });

  test("once its day has closed, a parked crawl laps with the two searches of its keyset", async () => {
    const model = await portalOverFixtures();
    servePortal(model);
    const { cursors } = await walkCrawl(null);
    const closed = parkedYesterday(cursors.at(-1) ?? null);
    model.requests.length = 0;

    const lap = await plUodoAdapter.fetchPage(closed, {});
    // The rest of its own millisecond, then everything after it; nothing new,
    // so it parks again on today.
    expect(model.requests).toHaveLength(2);
    expect(
      Result.isOk(lap) && parsePlUodoCursor(lap.value.nextCursor).parkedOn,
    ).toBe(todayUtc());
  });

  test("resumes from a banked cursor without reading a record twice or losing one", async () => {
    const model = await portalOverFixtures();
    servePortal(model);

    const first = await plUodoAdapter.fetchPage(null, {});
    const second = Result.isOk(first)
      ? await plUodoAdapter.fetchPage(first.value.nextCursor, {})
      : panic("the first page failed");
    const banked = Result.isOk(second)
      ? second.value.nextCursor
      : panic("the second page failed");
    const before = [
      ...(Result.isOk(first) ? first.value.decisions : []),
      ...(Result.isOk(second) ? second.value.decisions : []),
    ];

    // A new process, handed only the banked string.
    const after = await walkCrawl(banked);
    const stored = urnsOf([...before, ...after.decisions]);
    expect(stored.toSorted()).toEqual(inScopeUrns(model.records));
    expect(new Set(stored).size).toBe(stored.length);
  });

  test("records modified in the same millisecond across a page boundary are each read once", async () => {
    const model = await portalOverFixtures();
    const ordered = model.records.toSorted(compareBy(["mtime", "id"]));
    // Pages hold twenty records: give the 16th to 30th one modification time,
    // so it straddles the first page's end.
    const shared = ordered[15]?.["mtime"];
    model.records = ordered.map((record, index) =>
      index >= 15 && index < 30 ? withField(record, "mtime", shared) : record,
    );
    servePortal(model);

    const { decisions } = await walkCrawl(null);
    const stored = urnsOf(decisions);
    expect(stored.toSorted()).toEqual(inScopeUrns(model.records));
    expect(new Set(stored).size).toBe(stored.length);
  });

  test("a record read earlier that the portal modifies mid-walk moves nothing ahead of the cursor", async () => {
    // Twelve records share one millisecond and straddle the first page's end.
    // After the first page reads the start of that group, the portal modifies
    // one of them again, which takes it out of that millisecond. An offset
    // into the group would now point one record too far and never read it.
    const model = await portalOverFixtures();
    const ordered = model.records.toSorted(compareBy(["mtime", "id"]));
    const shared = ordered[14]?.["mtime"];
    model.records = ordered.map((record, index) =>
      index >= 14 && index < 26 ? withField(record, "mtime", shared) : record,
    );
    servePortal(model);

    const first = await plUodoAdapter.fetchPage(null, {});
    const firstPage = Result.isOk(first)
      ? first.value
      : panic("the first page failed");
    const readInGroup = model.records[14]?.["refid"];
    model.records = model.records.map((record) =>
      record["refid"] === readInGroup
        ? withField(record, "mtime", "2030-01-01T00:00:00.000Z")
        : record,
    );
    const rest = await walkCrawl(firstPage.nextCursor);
    const stored = new Set(urnsOf([...firstPage.decisions, ...rest.decisions]));
    const missing = inScopeUrns(model.records).filter(
      (urn) => !stored.has(urn),
    );
    expect(missing).toEqual([]);
  });

  test("a record the portal updates after the cursor passed it is read again", async () => {
    const model = await portalOverFixtures();
    servePortal(model);
    const { cursors } = await walkCrawl(null);
    const parked = parkedYesterday(cursors.at(-1) ?? null);

    // The portal adds the appeal outcome to a decision it served long ago.
    model.records = model.records.map((record) =>
      record["refid"] === DECISION_URN
        ? withField(record, "mtime", "2030-01-01T00:00:00.000Z")
        : record,
    );
    const next = await plUodoAdapter.fetchPage(parked, {});
    expect(
      Result.isOk(next) &&
        next.value.decisions.map(({ sourceDocumentId }) => sourceDocumentId),
    ).toEqual([DECISION_URN]);
  });

  test("a refused search fails the page and leaves the cursor to the caller", async () => {
    // The retry layer backs off between attempts; nothing here is live.
    Bun.sleep = async () => {
      // no-op
    };
    globalThis.fetch = asFetchMock(
      async () =>
        await Promise.resolve(
          new Response("Server got itself in trouble", { status: 500 }),
        ),
    );
    const cursor = encodePlUodoCursor({ mtimeMs: 1, afterId: undefined });
    const result = await plUodoAdapter.fetchPage(cursor, {});
    expect(Result.isError(result)).toBe(true);
  });

  test("a 200 that is not a list of records is a failure, not an empty page", async () => {
    globalThis.fetch = asFetchMock(
      async () =>
        await Promise.resolve(
          new Response(JSON.stringify({ error: "nope" }), {
            headers: { "Content-Type": "application/json" },
          }),
        ),
    );
    const result = await plUodoAdapter.fetchPage(null, {});
    expect(Result.isError(result)).toBe(true);
  });

  test("records out of modification order fail the page rather than advance past them", () => {
    const id = (n: number): string =>
      `PublicDocument-20250501-000000-000-${String(n).padStart(32, "0")}`;
    const start = { mtimeMs: 0, afterId: undefined };
    expect(
      nextPlUodoCursor(start, [
        normalizePlUodoRow({ mtime: "2025-05-02T00:00:00.000Z", id: id(1) }),
        normalizePlUodoRow({ mtime: "2025-05-01T00:00:00.000Z", id: id(2) }),
      ]),
    ).toBeUndefined();
    // Same millisecond, ids not rising: the tiebreak is out of order too.
    expect(
      nextPlUodoCursor(start, [
        normalizePlUodoRow({ mtime: "2025-05-01T00:00:00.000Z", id: id(2) }),
        normalizePlUodoRow({ mtime: "2025-05-01T00:00:00.000Z", id: id(1) }),
      ]),
    ).toBeUndefined();
    // A record at or before the cursor it was asked past.
    expect(
      nextPlUodoCursor(
        { mtimeMs: Date.parse("2025-05-01T00:00:00.000Z"), afterId: id(2) },
        [normalizePlUodoRow({ mtime: "2025-05-01T00:00:00.000Z", id: id(2) })],
      ),
    ).toBeUndefined();
    expect(
      nextPlUodoCursor(start, [
        normalizePlUodoRow({ mtime: undefined, id: id(1) }),
      ]),
    ).toBeUndefined();
  });

  test("an unreadable cursor starts from the first record rather than failing", () => {
    const start = { mtimeMs: 0, afterId: undefined };
    expect(parsePlUodoCursor("not-a-cursor")).toEqual(start);
    expect(parsePlUodoCursor(null)).toEqual(start);
    expect(parsePlUodoCursor("1748332226682:3")).toEqual(start);
    const cursor = {
      mtimeMs: 1_748_332_226_682,
      afterId:
        "PublicDocument-20230314-000000-000-13c64879b3624c79a3cd13a8e39754fb",
    };
    expect(parsePlUodoCursor(encodePlUodoCursor(cursor))).toEqual(cursor);
    expect(parsePlUodoCursor("1748332226682:")).toEqual({
      mtimeMs: 1_748_332_226_682,
      afterId: undefined,
    });
  });
});

// ── Reconciliation ───────────────────────────────────────

describe("the year census", () => {
  test("lists what a year holds that this adapter ingests, asked the way it was captured", async () => {
    const model = await portalOverFixtures();
    servePortal(model);

    const page = await plUodoAdapter.reconciliation.listSlicePage({
      slice: "2023",
      page: 0,
    });
    const [request] = model.requests;
    expect(request?.url.pathname).toBe(
      "/api/documents/search/PublicDocument/2023-01-01,2023-12-31",
    );
    expect(Object.fromEntries(request?.url.searchParams ?? [])).toEqual({
      count: "100",
      from: "0",
      order: "+id",
      fields: "*,mtime",
    });
    expect(page.totalPages).toBe(1);
    expect(
      page.items
        .map(({ identity }) =>
          identity.type === "document" ? identity.sourceDocumentId : "",
        )
        .toSorted(),
    ).toEqual(inScopeUrns(model.records));
  });

  test("a full page reports one more, and the walk ends on the short one", async () => {
    const records = await listingRecords();
    // Enough of the year's records to fill a page and spill into a second.
    const model: PortalModel = {
      records: [
        ...records,
        ...records.map((record, index) =>
          withField(
            withField(record, "id", `${String(record["id"])}-copy-${index}`),
            "refid",
            `${String(record["refid"])}_copy${index}`,
          ),
        ),
      ],
      bodies: new Map(),
      requests: [],
    };
    servePortal(model);

    const first = await plUodoAdapter.reconciliation.listSlicePage({
      slice: "2023",
      page: 0,
    });
    const second = await plUodoAdapter.reconciliation.listSlicePage({
      slice: "2023",
      page: 1,
    });
    expect(first.totalPages).toBe(2);
    expect(second.totalPages).toBe(2);
    expect(first.items.length + second.items.length).toBe(
      inScopeUrns(model.records).length,
    );
  });

  test("walks years from the portal's first to the present", () => {
    const { reconciliation } = plUodoAdapter;
    expect(reconciliation.firstSlice).toBe("1981");
    expect(reconciliation.previousSlice("1981")).toBeNull();
    expect(reconciliation.nextSlice("2022")).toBe("2023");
    expect(reconciliation.sliceOf(new Date("2026-09-23T10:00:00Z"))).toBe(
      "2026",
    );
    expect(
      reconciliation.nextSlice(reconciliation.sliceOf(new Date())),
    ).toBeNull();
  });

  test("the total counts the records this adapter ingests and nothing else", async () => {
    // The model returns only the fields the probe names, as the portal does,
    // so a field the classifier needs and the probe forgets counts a whole
    // class of records as nothing.
    const model = await portalOverFixtures();
    servePortal(model);
    expect(
      await plUodoAdapter.getTotalCount(new AbortController().signal),
    ).toEqual({ type: "count", total: inScopeUrns(model.records).length });
  });
});

// ── Unmapped fields ──────────────────────────────────────

describe("the field inventory", () => {
  test("declares every field any captured record states", async () => {
    const declared = plUodoAdapter.sourceFields.fields;
    const undeclared = new Set<string>();
    for (const listing of await listingRecords()) {
      for (const field of listPlUodoSourceFields(
        plUodoRawPartsOf(listing, undefined),
      )) {
        if (declared[field] === undefined) {
          undeclared.add(field);
        }
      }
    }
    expect([...undeclared]).toEqual([]);
  });

  test("names a field the portal starts sending, at the top level and nested", async () => {
    const listing = await recordOf(DECISION_URN);
    const dates: unknown[] = Array.isArray(listing["dates"])
      ? listing["dates"]
      : [];
    const changed = {
      ...listing,
      summary: { pl: "a field the record did not state before" },
      dates: [...dates, { date: "2024-01-01", use: "other", court: "x" }],
    };
    const declared = plUodoAdapter.sourceFields.fields;
    const undeclared = listPlUodoSourceFields(
      plUodoRawPartsOf(changed, undefined),
    ).filter((field) => declared[field] === undefined);

    expect(undeclared.toSorted()).toEqual(["dates[].court", "summary"]);
  });

  test("names a field the portal adds to a resource entry", async () => {
    const listing = await recordOf(DECISION_URN);
    const resources = isRecord(listing["resources"])
      ? listing["resources"]
      : {};
    const body = isRecord(resources["000_pl.xml"])
      ? resources["000_pl.xml"]
      : {};
    const changed = withField(listing, "resources", {
      ...resources,
      "000_pl.xml": withField(body, "encoding", "utf-8"),
    });
    const declared = plUodoAdapter.sourceFields.fields;
    const undeclared = listPlUodoSourceFields(
      plUodoRawPartsOf(changed, undefined),
    ).filter((field) => declared[field] === undefined);

    expect(undeclared).toEqual(["resources{}.encoding"]);
  });
});

// ── Rows the portal states badly ─────────────────────────

/** One page of the crawl over a single record, served by the model. */
const crawlOne = async (
  record: Record<string, unknown>,
  bodyAnswer?: () => Response,
) => {
  const model: PortalModel = {
    records: [record],
    bodies: new Map(),
    requests: [],
    bodyAnswer,
  };
  servePortal(model);
  return { model, result: await plUodoAdapter.fetchPage(null, {}) };
};

describe("a listed record is never dropped silently", () => {
  test("a record with no usable URN is kept verbatim under a quarantine identity", async () => {
    const listing = withField(await recordOf(DECISION_URN), "refid", "");
    const { model, result } = await crawlOne(listing);

    const [stored] = Result.isOk(result) ? result.value.decisions : [];
    expect(stored?.sourceDocumentId).toStartWith("pl-uodo-quarantine:");
    expect(stored).toMatchObject({
      isListingOnly: true,
      caseNumber: "DKN.5131.45.2022",
      court: "Prezes Urzędu Ochrony Danych Osobowych",
      metadata: { detailStatus: PL_UODO_BODY_STATUS.IDENTITY_UNAVAILABLE },
    });
    expect(
      JSON.parse(
        decodeSourceRawEnvelope(stored?.sourceRaw ?? "")?.["listing"] ?? "",
      ),
    ).toEqual(listing);
    // With no URN there is no document address to ask.
    expect(
      model.requests.filter(({ url }) =>
        url.pathname.startsWith(EVENTS_PREFIX),
      ),
    ).toEqual([]);
    // The reconciliation counts it held on its record, as it can hold no more.
    expect(
      plUodoAdapter.reconciliation.heldWithoutDetail?.({
        type: "document",
        sourceDocumentId: stored?.sourceDocumentId ?? "",
      }),
    ).toBe(true);
  });

  test("the record, once the portal states its URN, can adopt the quarantined row", async () => {
    const listing = await recordOf(DECISION_URN);
    const quarantined = builtDecision(
      buildFrom(withField(listing, "refid", "not a urn"), undefined),
    );
    const recovered = builtDecision(buildFrom(listing, undefined));

    expect(recovered.sourceDocumentId).toBe(DECISION_URN);
    expect(recovered.sourceDocumentIdRepairAliases).toEqual([
      quarantined.sourceDocumentId ?? "",
    ]);
  });

  test("a record with nothing to key or fingerprint is reported, not stored as a guess", () => {
    const row = normalizePlUodoRow({
      publicator: { type: "court", subtype: "sa", country: "pl" },
    });
    expect(plUodoListingIdentity(row)).toEqual({ type: "unidentifiable" });
  });

  test("a record with no docket is stored under a placeholder marked as one", async () => {
    const listing = withField(await recordOf(RULING_URN), "refname", null);
    expect(builtDecision(buildFrom(listing, undefined))).toMatchObject({
      caseNumber: RULING_URN,
      caseNumberIsPlaceholder: true,
    });
  });
});

describe("a listing that does not deliver what it lists", () => {
  test("entries that are not records fail the page instead of advancing past them", async () => {
    globalThis.fetch = asFetchMock(
      async () =>
        await Promise.resolve(
          new Response(
            JSON.stringify([
              "PublicDocument-20230314-000000-000-13c64879b3624c79a3cd13a8e39754fb",
            ]),
            { headers: { "Content-Type": "application/json" } },
          ),
        ),
    );
    const result = await plUodoAdapter.fetchPage(null, {});
    expect(Result.isError(result)).toBe(true);
  });

  test("a redirected search fails the page rather than reading as empty", async () => {
    for (const status of [301, 307]) {
      globalThis.fetch = asFetchMock(
        async (_input: string | URL | Request, init?: RequestInit) =>
          await refusingRedirects(
            new Response(null, {
              status,
              headers: { Location: "https://example.org/" },
            }),
            init,
          ),
      );
      const result = await plUodoAdapter.fetchPage(null, {});
      expect(Result.isError(result), String(status)).toBe(true);
    }
  });
});

describe("a decision body the portal does not serve", () => {
  test("an answer that holds for good stores the decision on its record", async () => {
    const listing = await recordOf(DECISION_URN);
    for (const [status, reason] of [
      [404, PL_UODO_BODY_STATUS.NOT_FOUND],
      [410, PL_UODO_BODY_STATUS.GONE],
      // Refused by the redirect guard, so its kind cannot be read: kept as a
      // record the repair asks again rather than a page failing every cycle.
      [301, PL_UODO_BODY_STATUS.REDIRECTED],
      [302, PL_UODO_BODY_STATUS.REDIRECTED],
    ] as const) {
      const { result } = await crawlOne(
        listing,
        () =>
          new Response(null, {
            status,
            headers: { Location: "https://example.org/" },
          }),
      );
      expect(Result.isOk(result), String(status)).toBe(true);
      const [stored] = Result.isOk(result) ? result.value.decisions : [];
      expect(stored, String(status)).toMatchObject({
        sourceDocumentId: DECISION_URN,
        isListingOnly: true,
        metadata: { detailStatus: reason },
      });
    }
  });

  test("an answer that may clear fails the page so it is asked again", async () => {
    Bun.sleep = async () => {
      // no-op: the retry layer backs off between attempts
    };
    const listing = await recordOf(DECISION_URN);
    for (const status of [429, 500, 503, 403]) {
      const { result } = await crawlOne(
        listing,
        () =>
          new Response(null, {
            status,
            headers: { Location: "https://example.org/" },
          }),
      );
      expect(Result.isError(result), String(status)).toBe(true);
    }
  });

  test("a replay keeps the reason the row was stored with", async () => {
    const listing = await recordOf(DECISION_URN);
    const { result } = await crawlOne(
      listing,
      () => new Response(null, { status: 410 }),
    );
    const [stored] = Result.isOk(result) ? result.value.decisions : [];
    const replayed = await plUodoAdapter.reparseStoredRaw?.({
      raw: new TextEncoder().encode(stored?.sourceRaw ?? ""),
      contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      caseNumber: stored?.caseNumber ?? "",
      sourceDocumentId: stored?.sourceDocumentId ?? null,
      language: "pl",
      court: stored?.court ?? "",
      ecli: null,
      decisionDate: null,
      decisionType: null,
      sourceUrl: null,
      documentUrl: null,
      metadata: stored?.metadata ?? {},
    });
    expect(
      replayed?.type === "parsed" && replayed.result.metadata["detailStatus"],
    ).toBe(PL_UODO_BODY_STATUS.GONE);
  });
});

describe("the deciding office", () => {
  const withSigningLine = (
    record: Record<string, unknown>,
    title: string | undefined,
  ): Record<string, unknown> => {
    const entities: unknown[] = Array.isArray(record["entities"])
      ? record["entities"]
      : [];
    return withField(
      record,
      "entities",
      entities.flatMap((entity) => {
        if (!isRecord(entity) || entity["function"] !== "creator") {
          return [entity];
        }
        return title === undefined
          ? []
          : [withField(entity, "title", { pl: title })];
      }),
    );
  };

  test("is read off the record's signing line, including a signature on authority", async () => {
    const listing = withSigningLine(
      await recordOf(DECISION_URN),
      "z up. Prezesa Urzędu Ochrony Danych Osobowych",
    );
    expect(builtDecision(buildFrom(listing, undefined))).toMatchObject({
      court: "Prezes Urzędu Ochrony Danych Osobowych",
      metadata: {
        issuedByTitle: "z up. Prezesa Urzędu Ochrony Danych Osobowych",
        signedOnAuthority: true,
      },
    });
  });

  test("a record naming no office this adapter knows is counted out, never filed under the portal's name", async () => {
    for (const title of [undefined, "Dyrektor Departamentu"]) {
      const row = normalizePlUodoRow(
        withSigningLine(await recordOf(DECISION_URN), title),
      );
      expect(classifyPlUodoRow(row)).toEqual({
        type: "skipped",
        reason: PL_UODO_SKIP_REASON.UNRECOGNISED_AUTHORITY,
      });
      expect(tallyPlUodoSkips([row])).toEqual({
        [PL_UODO_SKIP_REASON.UNRECOGNISED_AUTHORITY]: 1,
      });
    }
  });
});

describe("the stored listing", () => {
  test("is the record as served, fields this adapter does not read included", async () => {
    const served = withField(
      await recordOf(RULING_URN),
      "aFieldNobodyReadsYet",
      { pl: "kept" },
    );
    const stored = builtDecision(buildFrom(served, undefined));
    expect(
      JSON.parse(
        decodeSourceRawEnvelope(stored.sourceRaw ?? "")?.["listing"] ?? "",
      ),
    ).toEqual(served);
  });
});
