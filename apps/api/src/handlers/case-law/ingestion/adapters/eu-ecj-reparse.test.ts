/* eslint-disable typescript-eslint/promise-function-async -- fetch mock callbacks return Promise.resolve without being async */
import { afterEach, describe, expect, mock, test } from "bun:test";

import type {
  IngestionResult,
  StoredRawReparseInput,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  buildDecision,
  euEcjAdapter,
} from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

import sparqlFixture from "./__fixtures__/eu-ecj-sparql.json";

// The replay seam has one job: given the payload the crawl stored, produce
// the result the crawl produced. These tests hold the two ends together, so
// the seam cannot start writing something a crawl never would.

const fulltextHtml = await Bun.file(
  new URL("__fixtures__/eu-ecj-fulltext-en.html", import.meta.url),
).text();

const binding = sparqlFixture.results.bindings.at(0);
if (!binding) {
  throw new TypeError("Expected a CJEU SPARQL fixture binding");
}

const enBinding = {
  ...binding,
  language: {
    type: "uri",
    value: "http://publications.europa.eu/resource/authority/language/ENG",
  },
  manifestation: {
    type: "uri",
    value:
      "http://publications.europa.eu/resource/cellar/" +
      "5980acd6-b5e4-11ee-b164-01aa75ed71a1.0011.05",
  },
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const crawlDecision = async (): Promise<IngestionResult> => {
  globalThis.fetch = asFetchMock(
    mock(() =>
      Promise.resolve(
        new Response(fulltextHtml, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      ),
    ),
  );
  const decision = await buildDecision(enBinding, AbortSignal.timeout(30_000));
  if (!decision) {
    throw new TypeError("Expected the fixture manifestation to parse");
  }
  return decision;
};

/**
 * The stored row as the pipeline writes it from an ingestion result: the raw
 * payload plus the columns the replay reads back.
 */
const storedFrom = (
  decision: IngestionResult,
  overrides: Partial<StoredRawReparseInput> = {},
): StoredRawReparseInput => ({
  raw:
    decision.sourceRawBytes ??
    new TextEncoder().encode(decision.sourceRaw ?? ""),
  contentType: decision.sourceRawContentType ?? null,
  caseNumber: decision.caseNumber,
  sourceDocumentId: decision.sourceDocumentId ?? null,
  language: decision.language,
  court: decision.court,
  ecli: decision.ecli ?? null,
  decisionDate: decision.decisionDate ?? null,
  decisionType: decision.decisionType ?? null,
  sourceUrl: decision.sourceUrl ?? null,
  documentUrl: decision.documentUrl ?? null,
  metadata: decision.metadata,
  ...overrides,
});

const reparse = euEcjAdapter.reparseStoredRaw;
if (!reparse) {
  throw new TypeError("Expected eu-ecj to implement reparseStoredRaw");
}

describe("eu-ecj reparseStoredRaw", () => {
  test("stores the publisher XHTML as verbatim bytes", async () => {
    const crawled = await crawlDecision();

    expect(new TextDecoder().decode(crawled.sourceRawBytes)).toBe(fulltextHtml);
    expect(crawled.sourceRawContentType).toContain("stella-storage=verbatim");
  });

  test("reproduces the crawl's result from the payload the crawl stored", async () => {
    const crawled = await crawlDecision();

    // No fetch is installed for the re-parse: a call to the publisher here
    // fails the test rather than passing silently.
    globalThis.fetch = asFetchMock(
      mock(() => {
        throw new Error("reparseStoredRaw must not contact the publisher");
      }),
    );

    const outcome = await reparse(storedFrom(crawled));

    expect(outcome.type).toBe("parsed");
    if (outcome.type !== "parsed") {
      return;
    }
    // Field-for-field, including the hash the pipeline dedupes on: that
    // equality is what makes a second replay a no-op instead of a rewrite.
    expect(outcome.result).toEqual(crawled);
  });

  test("rejects a payload stored under a media type it does not parse", async () => {
    const crawled = await crawlDecision();

    const outcome = await reparse(
      storedFrom(crawled, { contentType: "application/pdf" }),
    );

    expect(outcome).toMatchObject({
      type: "rejected",
      rejection: "unsupported-content",
    });
  });

  test("rejects legacy bytes whose keyword spacing is ambiguous", async () => {
    const crawled = await crawlDecision();
    const ambiguous = `
      <html><body>
        <p class="coj-index">(Regula (ES) 2016/679 – 2. panta 2. punkts)</p>
      </body></html>`;

    const outcome = await reparse(
      storedFrom(crawled, {
        contentType: "application/xhtml+xml",
        raw: new TextEncoder().encode(ambiguous),
      }),
    );

    expect(outcome).toMatchObject({
      type: "rejected",
      rejection: "raw-fidelity-lost",
    });
  });

  test("rejects a row whose metadata lost the publisher id", async () => {
    const crawled = await crawlDecision();
    const { celex: _celex, ...metadataWithoutCelex } = crawled.metadata;

    const outcome = await reparse(
      storedFrom(crawled, { metadata: metadataWithoutCelex }),
    );

    expect(outcome).toMatchObject({
      type: "rejected",
      rejection: "incomplete-metadata",
    });
    if (outcome.type === "rejected") {
      expect(outcome.detail).toContain("celex");
    }
  });

  test("rejects a payload the parser can draw no text from", async () => {
    const crawled = await crawlDecision();

    const outcome = await reparse(
      storedFrom(crawled, {
        raw: new TextEncoder().encode("<html><body></body></html>"),
      }),
    );

    expect(outcome).toMatchObject({
      type: "rejected",
      rejection: "no-document",
    });
  });
});
