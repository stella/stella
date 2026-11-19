/* oxlint-disable typescript/promise-function-async -- fetch mock callbacks return Promise.resolve without being async */
import { Result } from "better-result";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import {
  euEcjAdapter,
  parseEcjCrawlCursor,
} from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import {
  decodeSourceRawEnvelope,
  type SyncPage,
} from "@/api/lib/legal-search/ingestion-types";
import { logger } from "@/api/lib/observability/logger";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const testFetchState = createTestFetch();

const DATE = "2024-01-18";
const NEXT_DATE = "2024-01-19";
const CELLAR = "https://publications.europa.eu/resource/cellar/";
const LANGUAGES = ["ENG", "FRA"] as const;
/** More decisions than one page builds, so a date takes several pages. */
const DECISIONS = 30;

type Variant = {
  celex: string;
  cellarLanguage: (typeof LANGUAGES)[number];
  manifestationId: string;
  sourceDocumentId: string;
  binding: Record<string, { type: string; value: string }>;
};

const variants: Variant[] = Array.from({ length: DECISIONS }, (_, index) =>
  LANGUAGES.map((cellarLanguage, languageIndex): Variant => {
    const celex = `62023CJ${String(100 + index).padStart(4, "0")}`;
    const manifestationId = `00000000-0000-0000-0000-${index
      .toString(16)
      .padStart(12, "0")}.${languageIndex + 1}.01`;
    return {
      celex,
      cellarLanguage,
      manifestationId,
      sourceDocumentId: `${celex}:${cellarLanguage === "ENG" ? "en" : "fr"}`,
      binding: {
        ecli: { type: "literal", value: `ECLI:EU:C:2024:${index + 1}` },
        date: { type: "literal", value: DATE },
        celex: { type: "literal", value: celex },
        type: {
          type: "uri",
          value: "http://publications.europa.eu/ontology/cdm#judgement",
        },
        language: {
          type: "uri",
          value: `http://publications.europa.eu/resource/authority/language/${cellarLanguage}`,
        },
        manifestation: {
          type: "uri",
          value: `http://publications.europa.eu/resource/cellar/${manifestationId}`,
        },
        manifestationType: { type: "literal", value: "xhtml" },
      },
    };
  }),
).flat();

const allIds = variants.map(({ sourceDocumentId }) => sourceDocumentId);

const documentHtml = `<html><body><p class="coj-normal">${"Judgment of the Court. ".repeat(
  20,
)}</p></body></html>`;

const requestUrl = (input: string | URL | Request): string => {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
};

type DocumentAnswer = (
  variant: Variant,
  init: RequestInit | undefined,
) => Promise<Response> | undefined;

/**
 * Cellar for one date: the listing in reverse key order, so the walk's order
 * is its own rather than the listing's; no branch notice; and each variant's
 * document, unless `answer` says otherwise.
 */
const installCellar = (
  answer?: DocumentAnswer,
  listed: readonly Variant[] = variants,
) => {
  const documentFetches: string[] = [];
  testFetchState.set(
    asFetchMock((input, init) => {
      const url = requestUrl(input);
      if (url.includes("sparql")) {
        return Promise.resolve(
          Response.json({
            results: {
              bindings: listed.map(({ binding }) => binding).toReversed(),
            },
          }),
        );
      }
      if (url.includes("/resource/celex/")) {
        return Promise.resolve(new Response("Not found", { status: 404 }));
      }
      const variant = listed.find(
        ({ manifestationId }) => url === `${CELLAR}${manifestationId}`,
      );
      if (variant === undefined) {
        return Promise.resolve(new Response("Not found", { status: 404 }));
      }
      documentFetches.push(variant.sourceDocumentId);
      return (
        answer?.(variant, init) ??
        Promise.resolve(
          new Response(documentHtml, {
            headers: { "Content-Type": "text/html" },
          }),
        )
      );
    }),
  );
  return { documentFetches };
};

const fetchPage = async (
  cursor: string,
  signal?: AbortSignal,
): Promise<SyncPage> => {
  const result = await euEcjAdapter.fetchPage(cursor, {}, signal);
  if (!Result.isOk(result)) {
    throw result.error;
  }
  return result.value;
};

/** Walk the date from `cursor` until the crawl leaves it; bounded. */
const walkDate = async (cursor: string) => {
  const built: string[] = [];
  const pages: SyncPage[] = [];
  let position = cursor;
  for (let page = 0; page < 20 && position.startsWith(DATE); page++) {
    const fetched = await fetchPage(position);
    pages.push(fetched);
    built.push(
      ...fetched.decisions.flatMap(({ sourceDocumentId }) =>
        sourceDocumentId === undefined ? [] : [sourceDocumentId],
      ),
    );
    position = fetched.nextCursor ?? "";
  }
  return { built, pages, position };
};

describe("eu-ecj crawl position within a date", () => {
  const originalSleep = Bun.sleep;

  beforeEach(() => {
    Bun.sleep = () => Promise.resolve();
  });

  afterEach(() => {
    mock.restore();
    testFetchState.restore();
    Bun.sleep = originalSleep;
  });

  test("a date larger than one page is walked to its end, each variant built once", async () => {
    const { documentFetches } = installCellar();

    const { built, pages, position } = await walkDate(DATE);

    // The fixture has to outgrow a page, or the walk proves nothing.
    expect(pages.length).toBeGreaterThan(2);
    expect(
      Math.max(...pages.map(({ decisions }) => decisions.length)),
    ).toBeLessThan(variants.length);
    expect(position).toBe(NEXT_DATE);
    expect(built.toSorted()).toEqual(allIds.toSorted());
    expect(documentFetches.toSorted()).toEqual(allIds.toSorted());
    for (const page of pages.slice(0, -1)) {
      expect(parseEcjCrawlCursor(page.nextCursor ?? "")).toMatchObject({
        date: DATE,
        after: expect.any(String),
      });
    }
  });

  test("a page fetched again from the same cursor answers the same", async () => {
    installCellar();
    const first = await fetchPage(DATE);
    const cursor = first.nextCursor ?? "";

    const once = await fetchPage(cursor);
    const again = await fetchPage(cursor);

    expect(again.nextCursor).toBe(once.nextCursor);
    expect(
      again.decisions.map(({ sourceDocumentId }) => sourceDocumentId),
    ).toEqual(once.decisions.map(({ sourceDocumentId }) => sourceDocumentId));
  });

  test("a page its budget cuts short keeps what it settled, and the next page continues there", async () => {
    const budget = new AbortController();
    let requested = 0;
    const settledBeforeCut = 5;
    const { documentFetches } = installCellar(() => {
      requested++;
      if (requested <= settledBeforeCut) {
        return undefined;
      }
      // The budget runs out while this variant's document is in flight.
      const timedOut = new DOMException(
        "The operation timed out.",
        "TimeoutError",
      );
      budget.abort(timedOut);
      return Promise.reject(timedOut);
    });

    const cut = await fetchPage(DATE, budget.signal);

    expect(cut.decisions).toHaveLength(settledBeforeCut);
    const settled = cut.decisions.flatMap(({ sourceDocumentId }) =>
      sourceDocumentId === undefined ? [] : [sourceDocumentId],
    );
    expect(parseEcjCrawlCursor(cut.nextCursor ?? "")).toMatchObject({
      date: DATE,
      after: expect.any(String),
    });

    installCellar();
    const rest = await walkDate(cut.nextCursor ?? "");

    expect(rest.position).toBe(NEXT_DATE);
    expect([...settled, ...rest.built].toSorted()).toEqual(allIds.toSorted());
    // Only the variant in flight when the budget ran out is asked for again.
    expect(documentFetches).toHaveLength(settledBeforeCut + 1);
  });

  test("a page that settles nothing fails instead of reporting an empty page", async () => {
    const budget = new AbortController();
    installCellar(() => {
      const timedOut = new DOMException(
        "The operation timed out.",
        "TimeoutError",
      );
      budget.abort(timedOut);
      return Promise.reject(timedOut);
    });

    const result = await euEcjAdapter.fetchPage(DATE, {}, budget.signal);

    expect(Result.isError(result)).toBe(true);
    if (!Result.isError(result)) {
      throw new TypeError("Expected the page to fail");
    }
    expect(result.error).toBeInstanceOf(AdapterFetchError);
    expect(result.error).toMatchObject({ cursor: DATE });
  });

  test("a variant the publisher fails to serve is carried as unread and ends the page", async () => {
    const failing = 2;
    const { documentFetches } = installCellar((variant) =>
      variant.sourceDocumentId === allIds.toSorted()[failing]
        ? Promise.resolve(new Response("Unavailable", { status: 500 }))
        : undefined,
    );
    const ordered = allIds.toSorted();
    const failingId = ordered[failing];

    const page = await fetchPage(DATE);

    expect(
      page.decisions.map(({ sourceDocumentId }) => sourceDocumentId),
    ).toEqual(ordered.slice(0, failing));
    // A publisher already failing is not asked for the rest of the page.
    expect(documentFetches).toEqual(ordered.slice(0, failing + 1));
    expect(page.unreadItems).toHaveLength(1);
    const unread = page.unreadItems?.at(0);
    expect(unread?.outcome).toEqual({
      type: "unavailable",
      cause: { kind: "status", status: 500 },
    });
    expect(unread?.listing).toMatchObject({
      sourceDocumentId: failingId,
      isListingOnly: true,
      decisionDate: DATE,
      court: expect.any(String),
    });
    expect(unread?.listing.fulltext).toBeUndefined();
    const failingVariant = variants.find(
      ({ sourceDocumentId }) => sourceDocumentId === failingId,
    );
    expect(decodeSourceRawEnvelope(unread?.listing.sourceRaw ?? "")).toEqual({
      listing: JSON.stringify(failingVariant?.binding),
    });

    // Once the pipeline lets the position move, the walk resumes after it.
    installCellar();
    const next = await fetchPage(page.nextCursor ?? "");
    expect(next.decisions.at(0)?.sourceDocumentId).toBe(ordered[failing + 1]);
  });

  test("a variant whose build the budget interrupts after a rejected manifestation stays pending", async () => {
    const budget = new AbortController();
    const ordered = allIds.toSorted();
    const cutAt = 3;
    installCellar((variant) =>
      variant.sourceDocumentId === ordered[cutAt]
        ? Promise.resolve(new Response("Forbidden", { status: 403 }))
        : undefined,
    );
    // The budget runs out right after the publisher refuses the manifestation,
    // so the build comes back empty without having finished.
    spyOn(logger, "warn").mockImplementation((message) => {
      if (message === "case_law.ingestion.manifestation_rejected") {
        budget.abort(
          new DOMException("The operation timed out.", "TimeoutError"),
        );
      }
    });

    const cut = await fetchPage(DATE, budget.signal);

    expect(
      cut.decisions.map(({ sourceDocumentId }) => sourceDocumentId),
    ).toEqual(ordered.slice(0, cutAt));
    expect(parseEcjCrawlCursor(cut.nextCursor ?? "")?.after).toBe(
      ordered[cutAt - 1]?.replace(/:en$/u, ":ENG").replace(/:fr$/u, ":FRA"),
    );
    installCellar();
    const next = await fetchPage(cut.nextCursor ?? "");
    expect(next.decisions.at(0)?.sourceDocumentId).toBe(ordered[cutAt]);
  });

  test("an unserved variant whose ECLI names no known court is still carried as unread", async () => {
    const ordered = allIds.toSorted();
    const failingId = ordered[0];
    const listed = variants.map((variant): Variant =>
      variant.sourceDocumentId === failingId
        ? {
            ...variant,
            binding: {
              ...variant.binding,
              ecli: { type: "literal", value: "ECLI:EU:X:2024:1" },
            },
          }
        : variant,
    );
    installCellar(
      (variant) =>
        variant.sourceDocumentId === failingId
          ? Promise.resolve(new Response("Unavailable", { status: 503 }))
          : undefined,
      listed,
    );

    const page = await fetchPage(DATE);

    expect(page.decisions).toHaveLength(0);
    expect(page.unreadItems?.at(0)?.listing).toMatchObject({
      sourceDocumentId: failingId,
      court: "Court of Justice",
      isListingOnly: true,
    });
    expect(parseEcjCrawlCursor(page.nextCursor ?? "")).toMatchObject({
      date: DATE,
    });
  });

  test("an unread row projects the listing's metadata as a complete build does", async () => {
    const ordered = allIds.toSorted();
    const failingId = ordered[0];
    installCellar((variant) =>
      variant.sourceDocumentId === failingId
        ? Promise.resolve(new Response("Unavailable", { status: 500 }))
        : undefined,
    );
    const unread = (await fetchPage(DATE)).unreadItems?.at(0)?.listing;
    installCellar();
    const built = (await fetchPage(DATE)).decisions.find(
      ({ sourceDocumentId }) => sourceDocumentId === failingId,
    );

    const listingKeys = [
      "manifestationType",
      "manifestationUri",
      "languageUri",
      "cdmType",
    ];
    const listed = (metadata: Record<string, unknown> | undefined) =>
      Object.fromEntries(
        listingKeys.map((key) => [key, metadata?.[key]] as const),
      );
    expect(listed(built?.metadata)).toMatchObject({
      manifestationType: "xhtml",
    });
    expect(listed(unread?.metadata)).toEqual(listed(built?.metadata));
  });

  test("reconciliation does not count a listing-only row as held", () => {
    expect(euEcjAdapter.reconciliation.heldRequiresDetail).toBe(true);
  });

  test("a cursor that names no position is refused before the publisher is asked", async () => {
    const { documentFetches } = installCellar();

    expect(parseEcjCrawlCursor("2024-02-29:62023CJ0100(01):ENG")).toEqual({
      date: "2024-02-29",
      after: "62023CJ0100(01):ENG",
    });
    for (const cursor of [
      "2024-1-18",
      "",
      "2024-01-18:",
      "yesterday",
      "2024-02-30",
      "2023-02-29:62023CJ0100:ENG",
      "2024-01-18:Z",
      "2024-01-18:62023CJ0100",
      "2024-01-18:62023CJ0100:english",
    ]) {
      const result = await euEcjAdapter.fetchPage(cursor, {});
      expect(Result.isError(result)).toBe(true);
    }
    expect(documentFetches).toHaveLength(0);
  });
});
