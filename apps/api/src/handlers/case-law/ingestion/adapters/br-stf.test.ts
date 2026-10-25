import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import { isDocumentAst } from "@stll/legal-ast/document-ast";
import { rejectionOf } from "@stll/property-testing/rejection";
import { Temporal } from "@stll/time";

import {
  decodeSourceRawEnvelope,
  startIngestionCycle,
} from "@/api/handlers/case-law/ingestion/adapter";
import { BR_STF_SYNTHETIC_HIT } from "@/api/handlers/case-law/ingestion/adapters/__fixtures__/br-stf.synthetic";
import {
  assembleBrStfDecision,
  BR_STF_DOCUMENT_MISSING,
  brStfAdapter,
  brStfDocketOf,
  brStfDocumentRequestOf,
  brStfFrontierDayClosed,
  brStfInlineTextOf,
  brStfPaginatorUrlOf,
  buildBrStfDecision,
  encodeBrStfCursor,
  fetchBrStfPage,
  parseBrStfCursor,
  parseBrStfSlice,
  readBrStfSearchAnswer,
} from "@/api/handlers/case-law/ingestion/adapters/br-stf";
import type { BrStfCursor } from "@/api/handlers/case-law/ingestion/adapters/br-stf";
import {
  brStfTextParagraphs,
  parseBrStfPdf,
} from "@/api/handlers/case-law/ingestion/parsers/br-stf";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { isRecord } from "@/api/lib/type-guards";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const FIXTURES = new URL("__fixtures__/", import.meta.url);

const recordedHits = async (file: string) => {
  const raw = new TextDecoder().decode(
    Bun.gunzipSync(await Bun.file(new URL(file, FIXTURES)).bytes()),
  );
  const answer = readBrStfSearchAnswer(raw);
  if (answer === null) {
    throw new TypeError(`${file} is not a search answer`);
  }
  return answer.hits.map(({ hit }) => hit);
};

const sourceOf = (hit: Record<string, unknown>): Record<string, unknown> => {
  const source = hit["_source"];
  if (!isRecord(source)) {
    throw new TypeError("hit without _source");
  }
  return source;
};

type StubRequest = { url: string; method: string; body: unknown };

/** A fetch stand-in that records every request and answers through `respond`. */
const stubFetch = (respond: (request: StubRequest) => Response) => {
  const requests: StubRequest[] = [];
  globalThis.fetch = asFetchMock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const body: unknown =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const request = { url, method: init?.method ?? "GET", body };
      requests.push(request);
      return await Promise.resolve(respond(request));
    },
  );
  return requests;
};

const searchAnswer = (
  total: number,
  hits: readonly { hit: Record<string, unknown>; sort: unknown[] }[],
) =>
  Response.json({
    result: {
      hits: {
        total: { value: total, relation: "eq" },
        hits: hits.map(({ hit, sort }) => ({ ...hit, _score: null, sort })),
      },
    },
  });

/** A record that carries its own text, so building it sends no request. */
const inlineHit = (id: string, extra: Record<string, unknown> = {}) => ({
  ...BR_STF_SYNTHETIC_HIT,
  _id: id,
  _source: { ...BR_STF_SYNTHETIC_HIT._source, id, dg_unique: id, ...extra },
});

const NOW = Temporal.Instant.from("2026-10-25T12:00:00Z");

const decisionOf = async (hit: Record<string, unknown>) => {
  const built = await buildBrStfDecision(hit);
  if (built.type !== "built") {
    throw new TypeError(`expected a built decision, got ${built.type}`);
  }
  return built.decision;
};

describe("STF records as decisions", () => {
  test("an acórdão with inline text keeps its printed blocks and every stated field", async () => {
    const requests = stubFetch(() => new Response(null, { status: 500 }));
    const [hit] = await recordedHits("br-stf-search-acordaos-2020-03.json.gz");
    const decision = await decisionOf(hit!);
    expect(requests).toEqual([]);
    expect(decision).toMatchObject({
      caseNumber: "ADPF 482",
      sourceDocumentId: "sjur420478",
      court: "Supremo Tribunal Federal",
      country: "BRA",
      language: "pt",
      decisionDate: "2020-03-03",
      decisionType: "acórdão",
      sourceUrl:
        "https://jurisprudencia.stf.jus.br/pages/search/sjur420478/false",
      documentUrl:
        "https://portal.stf.jus.br/jurisprudencia/obterInteiroTeor.asp?idDocumento=752208101",
    });
    expect(decision.isListingOnly).toBeUndefined();
    expect(decision.textFields.headnote.type).toBe("present");
    expect(
      decision.judges?.map(
        ({ role, nameAsPrinted }) => `${role}: ${nameAsPrinted}`,
      ),
    ).toEqual(["rapporteur: ALEXANDRE DE MORAES"]);

    const record = decision.metadata["stfRecord"];
    if (!isRecord(record)) {
      throw new TypeError("stfRecord is not an object");
    }
    const source = sourceOf(hit!);
    const kept = Object.keys(source).filter(
      (key) => key !== "inteiro_teor_texto" && !key.endsWith("_html"),
    );
    expect(Object.keys(record).toSorted()).toEqual(kept.toSorted());

    const ast = decision.documentAst;
    if (!isDocumentAst(ast)) {
      throw new TypeError("expected a parsed document");
    }
    expect(ast.blocks.at(0)).toMatchObject({
      type: "heading",
      role: "decision-title",
      plainText: "ADPF 482",
    });
    // A printed block keeps its typeset lines as line breaks, and a page break
    // separates blocks rather than surviving as a control character.
    const party = ast.blocks.find((block) =>
      block.plainText.startsWith("ARGUIÇÃO DE DESCUMPRIMENTO"),
    );
    expect(party?.plainText).toBe(
      "ARGUIÇÃO DE DESCUMPRIMENTO DE PRECEITO FUNDAMENTAL 482\nDISTRITO FEDERAL\nRELATOR\nREQTE.(S)\nINTDO.(A/S)\nPROC.(A/S)(ES)\nAM. CURIAE.\nADV.(A/S)",
    );
    expect(ast.blocks.some((block) => block.plainText.includes("\f"))).toBe(
      false,
    );
    // Every word of the published text reaches the document; only a court's
    // paragraph marker moves out of the text into the block's number.
    const words = (text: string) => text.split(/\s+/u).filter(Boolean);
    const documentWords = new Set(
      words(ast.blocks.map(({ plainText }) => plainText).join(" ")),
    );
    expect(
      words(String(source["inteiro_teor_texto"])).filter(
        (word) => !documentWords.has(word) && !/^\d+[.)]$/u.test(word),
      ),
    ).toEqual([]);
  });

  test("the stored hit drops only the query's coordinates and keeps its fingerprint across walks", async () => {
    const [hit] = await recordedHits("br-stf-search-acordaos-2020-03.json.gz");
    const first = await decisionOf(hit!);
    const parts = decodeSourceRawEnvelope(first.sourceRaw ?? "");
    const stored: unknown = JSON.parse(parts?.["hit"] ?? "null");
    expect(stored).toEqual(hit);
    expect(isRecord(stored) && "sort" in stored).toBe(false);
    // The same record read by the frontier's sort hashes the same.
    const second = await decisionOf({ ...hit!, sort: [1, "x"], _score: null });
    expect(second.rawHash).toBe(first.rawHash);
  });

  test("a decisão prints one paragraph per line", async () => {
    const hits = await recordedHits(
      "br-stf-search-decisoes-2020-03-03.json.gz",
    );
    const decision = await decisionOf(hits[0]!);
    expect(decision).toMatchObject({
      caseNumber: "ADPF 628",
      decisionType: "decisão monocrática",
      sourceDocumentId: "despacho1077076",
    });
    const ast = decision.documentAst;
    if (!isDocumentAst(ast)) {
      throw new TypeError("expected a parsed document");
    }
    const lines = String(sourceOf(hits[0]!)["decisao_texto"])
      .split("\r\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(ast.blocks.slice(1).map(({ plainText }) => plainText)).toEqual(
      lines,
    );
    expect(decision.fulltext).toBe(lines.join("\n\n"));
  });

  test("text layouts split where the field says, never inside a paragraph", () => {
    expect(
      brStfTextParagraphs("a\nb\n\n c \fd\n\n\n", "printed-blocks"),
    ).toEqual([["a", "b"], ["c"], ["d"]]);
    expect(
      brStfTextParagraphs("a \r\n\r\n  b\r\nc", "line-paragraphs"),
    ).toEqual([["a"], ["b"], ["c"]]);
  });

  test("a title the grammar refuses falls back to the class and number, then to the title as published", () => {
    expect(brStfDocketOf({ titulo: "ARE 1624555 AgR" })).toEqual({
      caseNumber: "ARE 1624555 AgR",
      reading: { source: "titulo", asPublished: "ARE 1624555 AgR" },
    });
    expect(
      brStfDocketOf({
        titulo: "RE 123 XYZ",
        processo_classe_processual_unificada_classe_sigla: "RE",
        processo_numero: 123,
      }),
    ).toEqual({
      caseNumber: "RE 123",
      reading: { source: "class-and-number", asPublished: "RE 123 XYZ" },
    });
    expect(
      brStfDocketOf({
        titulo: "AORCPR 7",
        processo_classe_processual_unificada_classe_sigla: "AORCPR",
        processo_numero: 7,
      }),
    ).toEqual({
      caseNumber: "AORCPR 7",
      reading: { source: "unrecognised", asPublished: "AORCPR 7" },
    });
    expect(brStfDocketOf({})).toBeUndefined();
  });
});

describe("decision documents behind the record", () => {
  test("document links are rebuilt on the portal origin from their identifiers", () => {
    expect(
      brStfDocumentRequestOf(
        "http://portal.stf.jus.br/processos/downloadPeca.asp?id=15342736840&ext=.pdf",
      ),
    ).toEqual({
      type: "direct",
      url: "https://portal.stf.jus.br/processos/downloadPeca.asp?id=15342736840&ext=.pdf",
    });
    expect(
      brStfDocumentRequestOf(
        "https://portal.stf.jus.br/jurisprudencia/obterInteiroTeor.asp?numero=1903&classe=Pet-AgR&x=1",
      ),
    ).toEqual({
      type: "redirected",
      url: "https://portal.stf.jus.br/jurisprudencia/obterInteiroTeor.asp?numero=1903&classe=Pet-AgR",
    });
    for (const foreign of [
      "https://portal.stf.jus.br.example.org/processos/downloadPeca.asp?id=1",
      "https://portal.stf.jus.br:8443/processos/downloadPeca.asp?id=1",
      "https://portal.stf.jus.br/processos/outra.asp?id=1",
      "https://portal.stf.jus.br/processos/downloadPeca.asp?id=1x",
      "ftp://portal.stf.jus.br/processos/downloadPeca.asp?id=1",
    ]) {
      expect(brStfDocumentRequestOf(foreign)).toBeNull();
    }
    expect(
      brStfPaginatorUrlOf(
        "https://redir.stf.jus.br/paginadorpub/paginador.jsp?docTP=AC&docID=324934",
        "https://portal.stf.jus.br/",
      ),
    ).toBe(
      "https://redir.stf.jus.br/paginadorpub/paginador.jsp?docTP=AC&docID=324934",
    );
    expect(
      brStfPaginatorUrlOf(
        "https://evil.example/paginadorpub/paginador.jsp?docTP=AC&docID=1",
        "https://portal.stf.jus.br/",
      ),
    ).toBeNull();
  });

  test("an acórdão PDF behind the paginator's bot challenge is a listing-only row with that reason", async () => {
    const [hit] = await recordedHits("br-stf-search-acordaos-2000-03.json.gz");
    const requests = stubFetch(({ url }) =>
      url.startsWith("https://portal.stf.jus.br/")
        ? new Response(null, {
            status: 302,
            headers: {
              location:
                "https://redir.stf.jus.br/paginadorpub/paginador.jsp?docTP=AC&docID=324934",
            },
          })
        : new Response(null, {
            status: 202,
            headers: { "x-amzn-waf-action": "challenge" },
          }),
    );
    const decision = await decisionOf(hit!);
    expect(requests.map(({ url }) => url)).toEqual([
      "https://portal.stf.jus.br/jurisprudencia/obterInteiroTeor.asp?numero=762&classe=Ext",
      "https://redir.stf.jus.br/paginadorpub/paginador.jsp?docTP=AC&docID=324934",
    ]);
    expect(decision.isListingOnly).toBe(true);
    expect(decision.fulltext).toBeUndefined();
    expect(String(decision.caseNumber)).toBe("Ext 762");
    expect(decision.textFields.headnote.type).toBe("present");
    expect(JSON.stringify(decision.metadata["documentRead"])).toBe(
      JSON.stringify({
        status: "missing",
        url: "https://redir.stf.jus.br/paginadorpub/paginador.jsp?docTP=AC&docID=324934",
      }),
    );
    expect(String(decision.metadata["documentReadReason"])).toBe(
      BR_STF_DOCUMENT_MISSING.PUBLISHER_CHALLENGE,
    );
  });

  test("a redirect off the paginator origin is never followed", async () => {
    const [hit] = await recordedHits("br-stf-search-acordaos-2000-03.json.gz");
    const requests = stubFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: {
            location: "https://evil.example/paginadorpub/paginador.jsp",
          },
        }),
    );
    const decision = await decisionOf(hit!);
    expect(requests).toHaveLength(1);
    expect(String(decision.metadata["documentReadReason"])).toBe(
      BR_STF_DOCUMENT_MISSING.REDIRECT_NOT_ALLOWED,
    );
  });

  test("a document link outside the allowlist costs no request", async () => {
    const requests = stubFetch(() => new Response(null, { status: 500 }));
    const hit = inlineHit("sjur999002", {
      inteiro_teor_texto: null,
      inteiro_teor_url: "https://example.org/inteiro-teor.pdf",
    });
    const decision = await decisionOf(hit);
    expect(requests).toEqual([]);
    expect(decision.isListingOnly).toBe(true);
    expect(String(decision.metadata["documentReadReason"])).toBe(
      BR_STF_DOCUMENT_MISSING.URL_NOT_ALLOWED,
    );
  });

  test("a decisão without inline text is read from its PDF and keeps the file", async () => {
    const pdf = await Bun.file(
      new URL("br-stf-decisao-despacho1077076.pdf", FIXTURES),
    ).bytes();
    const requests = stubFetch(() => new Response(pdf));
    const [listed] = await recordedHits(
      "br-stf-search-decisoes-2020-03-03.json.gz",
    );
    const hit = {
      ...listed!,
      _source: { ...sourceOf(listed!), decisao_texto: null },
    };
    const decision = await decisionOf(hit);
    expect(requests.map(({ url }) => url)).toEqual([
      "https://portal.stf.jus.br/processos/downloadPeca.asp?id=15342736840&ext=.pdf",
    ]);
    expect(decision.isListingOnly).toBeUndefined();
    expect(decision.fulltext).toContain("PERDA SUPERVENIENTE");
    expect(decision.sourceRawObjects?.["document"]?.bytes).toEqual(pdf);
    const parts = decodeSourceRawEnvelope(decision.sourceRaw ?? "");
    expect(JSON.parse(parts?.["provenance"] ?? "{}")).toMatchObject({
      document: {
        url: "https://portal.stf.jus.br/processos/downloadPeca.asp?id=15342736840&ext=.pdf",
      },
    });
  });

  test("a document the publisher does not answer is held for the pipeline, not stored as absent", async () => {
    stubFetch(() => new Response("busy", { status: 503 }));
    const [listed] = await recordedHits(
      "br-stf-search-decisoes-2020-03-03.json.gz",
    );
    const hit = {
      ...listed!,
      _source: { ...sourceOf(listed!), decisao_texto: null },
    };
    const built = await buildBrStfDecision(hit);
    expect(built.type).toBe("unread");
    if (built.type === "unread") {
      expect(built.item.listing).toMatchObject({
        sourceDocumentId: "despacho1077076",
        isListingOnly: true,
      });
      expect(built.item.outcome.type).toBe("unavailable");
    }
    const reconciled = await brStfAdapter.reconciliation.buildDecision(hit);
    expect(reconciled.type).toBe("detail-unavailable");
  });

  test("the record and the document read assemble to the same row in crawl and reconciliation", async () => {
    stubFetch(() => new Response(null, { status: 500 }));
    const hit = inlineHit("sjur999003");
    const crawled = await decisionOf(hit);
    const reconciled = await brStfAdapter.reconciliation.buildDecision(hit);
    expect(reconciled).toEqual({ type: "built", decision: crawled });
    const assembled = await assembleBrStfDecision({
      hit,
      document: brStfInlineTextOf("acordaos", hit._source)!,
    });
    expect(assembled).toEqual({ type: "built", decision: crawled });
  });
});

// ── The crawl cursor ────────────────────────────────────

type SearchBody = {
  size: number;
  search_after?: unknown[];
  query: { bool: { filter: unknown[]; must_not?: unknown[] } };
};

const isSearchBody = (body: unknown): body is SearchBody =>
  isRecord(body) && typeof body["size"] === "number" && isRecord(body["query"]);

const rangeOf = (body: SearchBody, field: string) => {
  for (const clause of body.query.bool.filter) {
    if (isRecord(clause) && isRecord(clause["range"])) {
      const range = clause["range"][field];
      if (isRecord(range)) {
        return range;
      }
    }
  }
  return undefined;
};

/** A month of judgments the stub serves, sorted the way the sweep sorts. */
const monthOf = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    hit: inlineHit(`${prefix}${String(index).padStart(3, "0")}`),
    sort: [1000 + index, index, `${prefix}${index}`],
  }));

/** Serve `months` by judgment month, paging with `search_after` as the engine does. */
const sweepSource = (
  months: Record<string, ReturnType<typeof monthOf>>,
  totals: Record<string, number> = {},
) =>
  stubFetch(({ body }) => {
    if (!isSearchBody(body)) {
      return new Response(null, { status: 400 });
    }
    const judged = rangeOf(body, "julgamento_data");
    const month =
      judged === undefined ? "undated" : String(judged["gte"]).slice(0, 7);
    const all = months[month] ?? [];
    const after = body.search_after;
    const start =
      after === undefined
        ? 0
        : all.findIndex(
            ({ sort }) => JSON.stringify(sort) === JSON.stringify(after),
          ) + 1;
    return searchAnswer(
      totals[month] ?? all.length,
      all.slice(start, start + body.size),
    );
  });

const parseCursor = (cursor: string | null): BrStfCursor => {
  if (cursor === null) {
    throw new TypeError("the crawl returned a null cursor");
  }
  return parseBrStfCursor(cursor, NOW).unwrap();
};

const sweepAt = (window: string): string =>
  encodeBrStfCursor({
    v: 1,
    phase: "sweep",
    boundary: "2026-10-24",
    window,
    seen: 0,
  });

describe("the sweep pages a fixed set of each month to its end", () => {
  test("a month longer than a page is followed with search_after to its last record", async () => {
    const requests = sweepSource({ "2020-03": monthOf("a", 45) });
    const collected: string[] = [];
    let cursor: string | null = sweepAt("2020-03");
    for (let page = 0; page < 3; page += 1) {
      const result = await fetchBrStfPage(cursor, NOW);
      if (Result.isError(result)) {
        throw result.error;
      }
      collected.push(
        ...result.value.decisions.map((d) => d.sourceDocumentId ?? ""),
      );
      cursor = result.value.nextCursor;
    }
    expect(collected).toHaveLength(45);
    expect(new Set(collected).size).toBe(45);
    // Every request is restricted to records written before the boundary.
    for (const { body } of requests.slice(0, 3)) {
      expect(isSearchBody(body) && rangeOf(body, "dg_atualizado_em")).toEqual({
        lt: "2026-10-24T00:00:00",
      });
    }
    expect(parseCursor(cursor)).toMatchObject({ window: "2020-04", seen: 0 });
  });

  test("a month whose walk saw fewer records than it counts is walked again", async () => {
    sweepSource({ "2020-03": monthOf("a", 5) }, { "2020-03": 6 });
    const result = await fetchBrStfPage(sweepAt("2020-03"), NOW);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.decisions).toHaveLength(5);
    expect(parseCursor(result.value.nextCursor)).toEqual({
      v: 1,
      phase: "sweep",
      boundary: "2026-10-24",
      window: "2020-03",
      seen: 0,
    });
  });

  test("empty months are stepped over a bounded number at a time", async () => {
    const requests = sweepSource({});
    const result = await fetchBrStfPage(sweepAt("1900-01"), NOW);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(requests).toHaveLength(24);
    expect(parseCursor(result.value.nextCursor)).toMatchObject({
      window: "1902-01",
    });
  });

  test("the sweep ends with the undated records and hands over at its boundary", async () => {
    sweepSource({ undated: monthOf("u", 2) });
    const result = await fetchBrStfPage(sweepAt("2026-10"), NOW);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.decisions).toHaveLength(2);
    expect(parseCursor(result.value.nextCursor)).toEqual({
      v: 1,
      phase: "frontier",
      frontier: "2026-10-24",
      seen: 0,
    });
  });

  test("a fresh crawl starts at the first month with yesterday as its boundary", async () => {
    sweepSource({});
    const result = await fetchBrStfPage(null, NOW);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(parseCursor(result.value.nextCursor)).toMatchObject({
      phase: "sweep",
      boundary: "2026-10-24",
    });
  });

  test("a cursor this adapter did not write is refused", async () => {
    const requests = sweepSource({});
    const result = await fetchBrStfPage('{"page":3}', NOW);
    expect(Result.isError(result)).toBe(true);
    expect(requests).toEqual([]);
  });
});

describe("the frontier collects closed days of publisher writes", () => {
  const frontierAt = (frontier: string) =>
    encodeBrStfCursor({ v: 1, phase: "frontier", frontier, seen: 0 });

  test("a day that has not closed costs no request and returns the cursor given", async () => {
    const requests = sweepSource({});
    const cursor = frontierAt("2026-10-24");
    const result = await fetchBrStfPage(cursor, NOW);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(requests).toEqual([]);
    expect(result.value).toEqual({ decisions: [], nextCursor: cursor });
    expect(brStfFrontierDayClosed("2026-10-23", NOW)).toBe(true);
    expect(brStfFrontierDayClosed("2026-10-24", NOW)).toBe(false);
  });

  test("a closed day with new records collects them and moves on", async () => {
    const written = monthOf("w", 3);
    const requests = stubFetch(({ body }) => {
      if (!isSearchBody(body)) {
        return new Response(null, { status: 400 });
      }
      const day = String(rangeOf(body, "dg_atualizado_em")?.["gte"]).slice(
        0,
        10,
      );
      return day === "2026-10-22"
        ? searchAnswer(3, written)
        : searchAnswer(0, []);
    });
    const result = await fetchBrStfPage(frontierAt("2026-10-22"), NOW);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(requests).toHaveLength(1);
    expect(result.value.decisions).toHaveLength(3);
    expect(parseCursor(result.value.nextCursor)).toMatchObject({
      frontier: "2026-10-23",
    });
    const next = await fetchBrStfPage(result.value.nextCursor, NOW);
    if (Result.isError(next)) {
      throw next.error;
    }
    // 23 October closes, holds nothing, and the open 24th stops the walk.
    expect(requests).toHaveLength(2);
    expect(parseCursor(next.value.nextCursor)).toMatchObject({
      frontier: "2026-10-24",
    });
  });
});

describe("the paginator's bot challenge trips a breaker for the rest of its scope", () => {
  const PORTAL = "https://portal.stf.jus.br/";
  const PAGINATOR = "https://redir.stf.jus.br/";

  /** Three acórdãos with no inline text, each needing its PDF. */
  const challengedSource = async () => {
    const hits = await recordedHits("br-stf-search-acordaos-2000-03.json.gz");
    expect(hits).toHaveLength(3);
    return stubFetch(({ url, body }) => {
      if (isSearchBody(body)) {
        return searchAnswer(
          hits.length,
          hits.map((hit, index) => ({
            hit,
            sort: [index, index, String(hit["_id"])],
          })),
        );
      }
      return url.startsWith(PORTAL)
        ? new Response(null, {
            status: 302,
            headers: {
              location: `${PAGINATOR}paginadorpub/paginador.jsp?docTP=AC&docID=324934`,
            },
          })
        : new Response(null, {
            status: 202,
            headers: { "x-amzn-waf-action": "challenge" },
          });
    });
  };

  const pdfRequests = (requests: readonly StubRequest[]) =>
    requests.filter(
      ({ url }) => url.startsWith(PORTAL) || url.startsWith(PAGINATOR),
    );

  test("one challenged read stores the cycle's PDF-needing rows listing-only, and the next cycle asks again", async () => {
    const requests = await challengedSource();
    const cycle = startIngestionCycle();

    const first = await fetchBrStfPage(
      sweepAt("2000-03"),
      NOW,
      undefined,
      cycle,
    );
    if (Result.isError(first)) {
      throw first.error;
    }
    // One request chain: the portal's redirect, then the challenged paginator.
    expect(pdfRequests(requests).map(({ url }) => url.slice(0, 24))).toEqual([
      PORTAL.slice(0, 24),
      PAGINATOR.slice(0, 24),
    ]);
    expect(first.value.decisions).toHaveLength(3);
    for (const decision of first.value.decisions) {
      expect(decision.isListingOnly).toBe(true);
      expect(String(decision.metadata["documentReadReason"])).toBe(
        BR_STF_DOCUMENT_MISSING.PUBLISHER_CHALLENGE,
      );
    }
    expect(
      first.value.decisions.map((decision) =>
        JSON.stringify(decision.metadata["documentRead"]).includes(
          "not-requested",
        ),
      ),
    ).toEqual([false, true, true]);

    // A later page of the same cycle sends no PDF request at all.
    const again = await fetchBrStfPage(
      sweepAt("2000-03"),
      NOW,
      undefined,
      cycle,
    );
    if (Result.isError(again)) {
      throw again.error;
    }
    expect(again.value.decisions).toHaveLength(3);
    expect(pdfRequests(requests)).toHaveLength(2);

    // The next cycle tries the paginator again.
    const next = await fetchBrStfPage(
      sweepAt("2000-03"),
      NOW,
      undefined,
      startIngestionCycle(),
    );
    if (Result.isError(next)) {
      throw next.error;
    }
    expect(pdfRequests(requests)).toHaveLength(4);
  });

  test("a slice walk shares one breaker and keeps challenged identities to be asked for again", async () => {
    const requests = await challengedSource();
    const hits = await recordedHits("br-stf-search-acordaos-2000-03.json.gz");
    const { reconciliation } = brStfAdapter;
    const build =
      reconciliation.createSliceBuildDecision?.() ??
      reconciliation.buildDecision;
    const outcomes: string[] = [];
    for (const hit of hits) {
      outcomes.push((await build(hit)).type);
    }
    expect(outcomes).toEqual([
      "detail-unavailable",
      "detail-unavailable",
      "detail-unavailable",
    ]);
    expect(pdfRequests(requests)).toHaveLength(2);
    // A challenged row is not held, so the next walk lists it again; a row
    // whose publisher stated the file gone is.
    const held = reconciliation.heldWithoutDocument?.reasons ?? [];
    expect(held).not.toContain(BR_STF_DOCUMENT_MISSING.PUBLISHER_CHALLENGE);
    expect(held).toContain(BR_STF_DOCUMENT_MISSING.ABSENT);
    expect(reconciliation.heldWithoutDocument?.metadataKey).toBe(
      "documentReadReason",
    );
    expect(reconciliation.heldRequiresDetail).toBe(true);
  });

  test("the portal's own PDFs are still read once the paginator has challenged", async () => {
    const pdf = await Bun.file(
      new URL("br-stf-decisao-despacho1077076.pdf", FIXTURES),
    ).bytes();
    const requests = stubFetch(() => new Response(pdf));
    const [listed] = await recordedHits(
      "br-stf-search-decisoes-2020-03-03.json.gz",
    );
    const hit = {
      ...listed!,
      _source: { ...sourceOf(listed!), decisao_texto: null },
    };
    const built = await buildBrStfDecision(hit, undefined, {
      tripped: true,
      skipped: 0,
    });
    expect(requests).toHaveLength(1);
    expect(built.type === "built" && built.decision.isListingOnly).toBe(
      undefined,
    );
  });
});

describe("a rate-limit refusal halts the cycle", () => {
  test("a 429 to the search fails the page after one request", async () => {
    const requests = stubFetch(
      () =>
        new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "60" },
        }),
    );
    const result = await brStfAdapter.fetchPage(sweepAt("2020-03"), {});
    expect(requests).toHaveLength(1);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      const chain: unknown[] = [];
      let current: unknown = result.error;
      while (current instanceof Error) {
        chain.push(current);
        current = current.cause;
      }
      expect(
        chain.some(
          (error) =>
            error instanceof AdapterFetchError && error.httpStatus === 429,
        ),
      ).toBe(true);
    }
  });

  test("a 429 to a document read rejects instead of storing the row", async () => {
    const [listed] = await recordedHits(
      "br-stf-search-decisoes-2020-03-03.json.gz",
    );
    const hit = {
      ...listed!,
      _source: { ...sourceOf(listed!), decisao_texto: null },
    };
    const requests = stubFetch(() => new Response(null, { status: 429 }));
    expect(await rejectionOf(buildBrStfDecision(hit))).toMatchObject({
      httpStatus: 429,
    });
    expect(requests).toHaveLength(1);
  });
});

describe("reconciliation slices", () => {
  const { reconciliation } = brStfAdapter;

  test("slices walk months of both bases, undated records first", () => {
    expect(reconciliation.firstSlice).toBe("0000-00-acordaos");
    expect(reconciliation.nextSlice("0000-00-acordaos")).toBe(
      "0000-00-decisoes",
    );
    expect(reconciliation.nextSlice("0000-00-decisoes")).toBe(
      "1892-04-acordaos",
    );
    expect(reconciliation.nextSlice("2020-03-acordaos")).toBe(
      "2020-03-decisoes",
    );
    expect(reconciliation.nextSlice("2020-12-decisoes")).toBe(
      "2021-01-acordaos",
    );
    expect(reconciliation.previousSlice("1892-04-acordaos")).toBe(
      "0000-00-decisoes",
    );
    expect(reconciliation.previousSlice("2021-01-acordaos")).toBe(
      "2020-12-decisoes",
    );
    expect(reconciliation.previousSlice("0000-00-acordaos")).toBeNull();
    expect(reconciliation.sliceOf(new Date("2026-10-25T00:00:00Z"))).toBe(
      "2026-10-decisoes",
    );
    // Walk order is byte order, which the ledger relies on.
    const walked = ["0000-00-acordaos"];
    for (let step = 0; step < 30; step += 1) {
      const next = reconciliation.nextSlice(walked.at(-1)!);
      if (next === null) {
        break;
      }
      walked.push(next);
    }
    expect(walked).toEqual(walked.toSorted());
    expect(parseBrStfSlice("1892-03-acordaos")).toBeNull();
    expect(parseBrStfSlice("2020-13-acordaos")).toBeNull();
    expect(parseBrStfSlice("2020-03-sumulas")).toBeNull();
  });

  test("a slice's pages must add up to the count the publisher states", async () => {
    const records = monthOf("s", 150);
    stubFetch(({ body }) => {
      if (!isRecord(body) || typeof body["size"] !== "number") {
        return new Response(null, { status: 400 });
      }
      const after = body["search_after"];
      const offset = typeof body["from"] === "number" ? body["from"] : 0;
      const from = Array.isArray(after)
        ? records.findIndex(
            ({ sort }) => JSON.stringify(sort) === JSON.stringify(after),
          ) + 1
        : offset;
      return searchAnswer(150, records.slice(from, from + body["size"]));
    });
    const first = await reconciliation.listSlicePage({
      slice: "2020-03-acordaos",
      page: 0,
    });
    const second = await reconciliation.listSlicePage({
      slice: "2020-03-acordaos",
      page: 1,
    });
    expect(first.totalPages).toBe(2);
    expect(first.items).toHaveLength(100);
    expect(second.items).toHaveLength(50);
    expect(second.items.at(0)?.identity).toEqual({
      type: "document",
      sourceDocumentId: "s100",
    });

    // The listing moved under the walk: its last page is short of the count.
    stubFetch(() => searchAnswer(150, records.slice(100, 140)));
    expect(
      String(
        await rejectionOf(
          reconciliation.listSlicePage({ slice: "2020-03-acordaos", page: 1 }),
        ),
      ),
    ).toContain("listed 40 of the 50");

    stubFetch(() => searchAnswer(10_001, records.slice(0, 100)));
    expect(
      String(
        await rejectionOf(
          reconciliation.listSlicePage({ slice: "2020-03-decisoes", page: 0 }),
        ),
      ),
    ).toContain("past the 10000");
  });

  test("an unreadable search answer is a failure, not an empty slice", async () => {
    stubFetch(() => Response.json({ detail: "Excedido o limite" }));
    expect(
      String(
        await rejectionOf(
          reconciliation.listSlicePage({ slice: "2020-03-acordaos", page: 0 }),
        ),
      ),
    ).toContain("no readable result");
  });
});

describe("review fixes", () => {
  const { reconciliation } = brStfAdapter;

  /** A slice the stub serves by offset and by `search_after`, as the engine does. */
  const sliceSource = (records: { id: string; sort: number }[]) =>
    stubFetch(({ body }) => {
      if (!isRecord(body) || typeof body["size"] !== "number") {
        return new Response(null, { status: 400 });
      }
      const size = body["size"];
      const ordered = records.toSorted((left, right) => left.sort - right.sort);
      const after = body["search_after"];
      const from = typeof body["from"] === "number" ? body["from"] : 0;
      const start = Array.isArray(after)
        ? ordered.findIndex(({ sort }) => sort > Number(after[0]))
        : from;
      const page = start < 0 ? [] : ordered.slice(start, start + size);
      return searchAnswer(
        ordered.length,
        page.map(({ id, sort }) => ({
          hit: inlineHit(id),
          sort: [sort, sort, id],
        })),
      );
    });

  test("a slice that changed behind the consumed offset fails its verification pass", async () => {
    const records = Array.from({ length: 150 }, (_, index) => ({
      id: `v${String(index + 1).padStart(3, "0")}`,
      sort: (index + 1) * 10,
    }));
    sliceSource(records);
    const first = await reconciliation.listSlicePage({
      slice: "2020-03-acordaos",
      page: 0,
    });
    expect(first.items).toHaveLength(100);
    // Record 50 leaves the slice and X lands among the pages already read.
    records.splice(49, 1, { id: "vX", sort: 55 });
    const rejected = await rejectionOf(
      reconciliation.listSlicePage({ slice: "2020-03-acordaos", page: 1 }),
    );
    expect(String(rejected)).toContain("changed while it was listed");
  });

  test("an unchanged slice passes its verification pass", async () => {
    const records = Array.from({ length: 150 }, (_, index) => ({
      id: `u${String(index + 1).padStart(3, "0")}`,
      sort: index + 1,
    }));
    sliceSource(records);
    const first = await reconciliation.listSlicePage({
      slice: "2020-03-decisoes",
      page: 0,
    });
    const second = await reconciliation.listSlicePage({
      slice: "2020-03-decisoes",
      page: 1,
    });
    expect([...first.items, ...second.items]).toHaveLength(150);
  });

  test("a hit without a usable _id is keyed by its dg_unique, and one with neither is quarantined", async () => {
    stubFetch(() => new Response(null, { status: 500 }));
    const { _id: _dropped, ...withoutId } = inlineHit("sjur999007");
    const byDgUnique = await buildBrStfDecision(withoutId);
    expect(byDgUnique.type).toBe("built");
    if (byDgUnique.type === "built") {
      expect(byDgUnique.decision.sourceDocumentId).toBe("dg_unique:sjur999007");
    }
    const anonymous = {
      ...withoutId,
      _source: { ...withoutId._source, dg_unique: null, id: null },
    };
    const quarantined = await buildBrStfDecision(anonymous);
    const recovered = await buildBrStfDecision({
      ...anonymous,
      _id: "sjur999008",
    });
    expect([quarantined.type, recovered.type]).toEqual(["built", "built"]);
    if (quarantined.type === "built" && recovered.type === "built") {
      expect(String(quarantined.decision.sourceDocumentId)).toStartWith(
        "br-stf-quarantine:",
      );
      expect(recovered.decision.sourceDocumentId).toBe("sjur999008");
      expect(recovered.decision.sourceDocumentIdRepairAliases).toContain(
        quarantined.decision.sourceDocumentId,
      );
    }
  });

  test("a PDF once stated absent is asked for again by the bounded textless recheck", async () => {
    const [listed] = await recordedHits(
      "br-stf-search-decisoes-2020-03-03.json.gz",
    );
    const hit = {
      ...listed!,
      _source: { ...sourceOf(listed!), decisao_texto: null },
    };
    stubFetch(() => new Response(null, { status: 404 }));
    const absent = await decisionOf(hit);
    expect(String(absent.metadata["documentReadReason"])).toBe(
      BR_STF_DOCUMENT_MISSING.ABSENT,
    );
    const recheck = reconciliation.textlessHeldRecheck;
    expect(recheck?.values).toEqual(["absent", "not-a-pdf", "unreadable-pdf"]);
    const pdf = await Bun.file(
      new URL("br-stf-decisao-despacho1077076.pdf", FIXTURES),
    ).bytes();
    stubFetch(() => new Response(pdf));
    const rebuilt = await recheck?.buildDecisionFromStored({
      raw: new TextEncoder().encode(absent.sourceRaw ?? ""),
      contentType: absent.sourceRawContentType ?? null,
      caseNumber: absent.caseNumber,
      sourceDocumentId: absent.sourceDocumentId ?? null,
      language: absent.language,
      court: absent.court,
      ecli: null,
      decisionDate: absent.decisionDate ?? null,
      decisionType: absent.decisionType ?? null,
      sourceUrl: absent.sourceUrl ?? null,
      documentUrl: absent.documentUrl ?? null,
      metadata: absent.metadata,
    });
    expect(rebuilt?.type).toBe("built");
    if (rebuilt?.type === "built") {
      expect(rebuilt.decision.fulltext).toContain("PERDA SUPERVENIENTE");
    }
  });

  test("a PDF's footnotes are searchable text", async () => {
    const bytes = await Bun.file(
      new URL("cz-uohs-2026-R0137.pdf", FIXTURES),
    ).bytes();
    const parsed = await parseBrStfPdf(bytes, {
      title: undefined,
      caseNumber: "fixture",
      court: "Supremo Tribunal Federal",
      decisionDate: undefined,
      decisionType: "decisão monocrática",
      sourceUrl: "https://jurisprudencia.stf.jus.br/pages/search/x/false",
      documentUrl: undefined,
    });
    const note = "Ve správním spise se nachází pod položkou č. 16.";
    expect(
      parsed.documentAst.blocks.some(({ plainText }) => plainText === note),
    ).toBe(true);
    expect(parsed.fulltext.replaceAll(/\s+/gu, " ")).toContain(note);
  });
});
