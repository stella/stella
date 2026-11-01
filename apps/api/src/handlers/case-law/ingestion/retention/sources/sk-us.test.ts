import { afterEach, describe, expect, test } from "bun:test";

import { hasUsableAst } from "@stll/legal-ast/document-ast";

import {
  buildSkUsDecision,
  type SkUsPageContext,
} from "@/api/handlers/case-law/ingestion/adapters/sk-us";
import { skUsRetention } from "@/api/handlers/case-law/ingestion/retention/sources/sk-us";
import { readAbsent } from "@/api/lib/errors/read-outcome";
import { readGzipJson } from "@/api/lib/gzip-json";
import {
  encodeSourceRawEnvelope,
  type IngestionResult,
} from "@/api/lib/legal-search/ingestion-types";
import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";
import { isRecord } from "@/api/lib/type-guards";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const ADAPTER_FIXTURES = new URL(
  "../../adapters/__fixtures__/",
  import.meta.url,
);
const PARSER_FIXTURES = new URL("../../parsers/__fixtures__/", import.meta.url);

/** Every recorded content response the adapter's and parser's tests read. */
const RECORDED = [
  {
    name: "sk-us-content.json.gz",
    url: new URL("sk-us-content.json.gz", ADAPTER_FIXTURES),
    listing: {
      documentId: "75f2386e-0000-4000-8000-000000000001",
      mkRSAPNumberOfFile: "PL. ÚS 11/2021",
      mkDateOfDecision: "07/29/2021 00:00:00",
      mkFormOfDecision: "Uznesenie",
    },
  },
  {
    name: "sk-us-iii-us-265-2026.content.json.gz",
    url: new URL("sk-us-iii-us-265-2026.content.json.gz", PARSER_FIXTURES),
    listing: {
      documentId: "3a1c0b52-0000-4000-8000-000000000002",
      mkRSAPNumberOfFile: "III. ÚS 265/2026",
      mkDateOfDecision: "05/12/2026 00:00:00",
      mkFormOfDecision: "Uznesenie",
    },
  },
] as const;

/** The page's shared reads, answered absent: only the document matters here. */
const ABSENT_PAGE: SkUsPageContext = {
  collectionListing: async () => readAbsent("http-404"),
  codelist: async () => readAbsent("http-404"),
  facets: async () => readAbsent("http-404"),
  courtFile: async () => readAbsent("http-404"),
};

const recordedContent = async (url: URL): Promise<string> => {
  const payload = await readGzipJson(url);
  if (!isRecord(payload) || typeof payload["content"] !== "string") {
    throw new TypeError(`${url.pathname} states no content`);
  }
  return payload["content"];
};

/** The decision the crawl builds when the service answers with the recording. */
const crawledDecision = async (
  fixture: (typeof RECORDED)[number],
): Promise<IngestionResult> => {
  const content = await recordedContent(fixture.url);
  globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/o/v1/dms/content") {
      return new Response(JSON.stringify({ content }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname.startsWith("/docDownload/")) {
      return new Response(new TextEncoder().encode("%PDF-1.4\n"), {
        headers: { "Content-Type": "application/pdf" },
      });
    }
    return new Response(`unexpected request: ${url.toString()}`, {
      status: 500,
    });
  });
  const built = await buildSkUsDecision(fixture.listing, {
    context: ABSENT_PAGE,
  });
  if (built.type !== "built") {
    throw new Error(`expected a built decision, got ${built.type}`);
  }
  return built.decision;
};

describe("sk-us retention projection", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test.each(RECORDED.map((fixture) => [fixture.name, fixture] as const))(
    "the parsed decision keeps the rendered text: %s",
    async (_name, fixture) => {
      const decision = await crawledDecision(fixture);
      const ast = decision.documentAst;
      if (!hasUsableAst(ast)) {
        throw new Error("the recording built no document");
      }
      const projection = await skUsRetention.project(decision.sourceRaw ?? "");
      if (projection.type !== "source") {
        throw new Error(`expected a source projection, got ${projection.type}`);
      }

      const result = validateAst(
        projection.source,
        ast.blocks,
        projection.options,
      );

      expect(result.stats.missingWords).toEqual([]);
      expect(result.ok).toBe(true);
      // The projection measures something: a parse that lost the second half
      // of the decision fails against it.
      const halved = ast.blocks.slice(0, Math.ceil(ast.blocks.length / 2));
      expect(
        validateAst(projection.source, halved, projection.options).ok,
      ).toBe(false);
    },
  );

  test("a listing the service served no rendering for has no publisher text", async () => {
    const raw = encodeSourceRawEnvelope({ listing: "{}" });

    expect(await skUsRetention.project(raw)).toEqual({
      type: "no-text",
      reason: "not-published",
    });
  });

  test("a payload that is not the envelope is unreadable", async () => {
    expect(await skUsRetention.project('{"documentId":"x"}')).toEqual({
      type: "unreadable",
      reason: "unreadable-envelope",
    });
  });
});
