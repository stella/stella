import { panic, Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { decodeSourceRawEnvelope } from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import {
  assembleBrTjdftDecision,
  BR_TJDFT_PAGE_SIZE,
  brTjdftAdapter,
  brTjdftCalendarDay,
  brTjdftCaseNumberOf,
  brTjdftLastClosedDay,
  brTjdftSlice,
  createBrTjdftAdapter,
  encodeBrTjdftCursor,
  parseBrTjdftCursor,
  readBrTjdftSearch,
} from "@/api/handlers/case-law/ingestion/adapters/br-tjdft";
import type { BrTjdftCursor } from "@/api/handlers/case-law/ingestion/adapters/br-tjdft";
import { publisherRequestIntervalMs } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const SEARCH_URL = "https://jurisdf.tjdft.jus.br/api/v1/pesquisa";

/** 2026-10-25 12:00 in Brasília: the last closed publication day is the 24th. */
const NOW = new Date("2026-10-25T15:00:00.000Z");
const adapter = createBrTjdftAdapter({ now: () => NOW });

const fixtureText = async (name: string): Promise<string> =>
  new TextDecoder().decode(
    Bun.gunzipSync(
      new Uint8Array(
        await Bun.file(
          new URL(`__fixtures__/${name}`, import.meta.url),
        ).arrayBuffer(),
      ),
    ),
  );

const recordedAnswer = async (name: string) => {
  const raw = await fixtureText(name);
  return readBrTjdftSearch(raw) ?? panic(`${name} is not a search answer`);
};

/** A recorded one-record answer, assembled as the crawl assembles it. */
const assembledDetail = async (name: string): Promise<IngestionResult> => {
  const { raw, rows } = await recordedAnswer(name);
  const record = rows.at(0) ?? panic(`${name} holds no record`);
  return assembleBrTjdftDecision({
    listing: record,
    detail: { record, raw },
    detailStatus: undefined,
  });
};

// ── A stub publisher ─────────────────────────────────────

type Call = { url: string; method: string; body: Record<string, unknown> };

const uuidAt = (index: number): string =>
  `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

const rowAt = (
  index: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  sequencial: index + 1,
  base: "acordaos",
  subbase: "acordaos",
  uuid: uuidAt(index),
  identificador: String(1_800_000 + index),
  dataJulgamento: "2024-02-22T03:00:00.000Z",
  dataPublicacao: "2024-03-01T20:00:00.000Z",
  decisao: "NEGAR PROVIMENTO AO RECURSO. UNÂNIME",
  ementa: `APELAÇÃO CÍVEL. EMENTA DO JULGADO ${index}.`,
  processo: "0753268-53.2023.8.07.0000",
  nomeRelator: "ESDRAS NEVES",
  segredoJustica: false,
  descricaoOrgaoJulgador: "1ª TURMA CRIMINAL",
  possuiInteiroTeor: true,
  ...overrides,
});

const answer = (
  total: number,
  rows: readonly Record<string, unknown>[],
): Response =>
  new Response(
    JSON.stringify({
      hits: { value: total },
      agregacoes: {},
      paginacao: { pagina: 0, tamanho: BR_TJDFT_PAGE_SIZE },
      registros: rows,
    }),
    { headers: { "Content-Type": "application/json; charset=utf-8" } },
  );

const detailAnswer = (row: Record<string, unknown>): Response =>
  new Response(
    JSON.stringify({
      hits: { value: 1 },
      agregacoes: { classe: [{ nome: "APELAÇÃO CÍVEL", total: 1 }] },
      paginacao: { pagina: 0, tamanho: 1 },
      registros: [
        {
          ...row,
          inteiroTeorHtml: `<p><strong>EMENTA</strong></p><p>${String(row["ementa"])}</p><p><strong>ACÓRDÃO</strong></p><p>Acordam os Senhores Desembargadores.</p>`,
        },
      ],
    }),
    { headers: { "Content-Type": "application/json; charset=utf-8" } },
  );

const termOf = (body: Record<string, unknown>, campo: string) => {
  const terms = body["termosAcessorios"];
  if (!isUnknownArray(terms)) {
    return undefined;
  }
  const term = terms.find(
    (candidate) => isRecord(candidate) && candidate["campo"] === campo,
  );
  return isRecord(term) && typeof term["valor"] === "string"
    ? term["valor"]
    : undefined;
};

const isDetail = (call: Call) => termOf(call.body, "uuid") !== undefined;

const urlOf = (input: string | URL | Request): string => {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
};

const stubPublisher = (respond: (call: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = asFetchMock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const body: unknown = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      );
      const call = {
        url: urlOf(input),
        method: init?.method ?? "GET",
        body: isRecord(body) ? body : {},
      };
      calls.push(call);
      return await Promise.resolve(respond(call));
    },
  );
  return calls;
};

/** A window of rows served page by page, and each row's detail by its id. */
const windowPublisher = (
  rowsOf: (base: string) => readonly Record<string, unknown>[],
  totalOf: (base: string, page: number) => number = (base) =>
    rowsOf(base).length,
) =>
  stubPublisher((call) => {
    if (isDetail(call)) {
      const uuid = termOf(call.body, "uuid");
      const row = [...rowsOf("acordaos"), ...rowsOf("decisoes")].find(
        (candidate) => candidate["uuid"] === uuid,
      );
      return row === undefined ? answer(0, []) : detailAnswer(row);
    }
    const base = termOf(call.body, "base") ?? "";
    const page = Number(call.body["pagina"]);
    return answer(
      totalOf(base, page),
      rowsOf(base).slice(
        page * BR_TJDFT_PAGE_SIZE,
        (page + 1) * BR_TJDFT_PAGE_SIZE,
      ),
    );
  });

const cursorOf = (overrides: Partial<BrTjdftCursor> = {}): string =>
  encodeBrTjdftCursor({
    version: 1,
    day: "2024-03-01",
    base: "acordaos",
    page: 0,
    total: null,
    seen: [],
    excluded: 0,
    restarts: 0,
    ...overrides,
  });

const nextCursorOf = (page: Awaited<ReturnType<typeof adapter.fetchPage>>) =>
  Result.isOk(page)
    ? JSON.parse(page.value.nextCursor ?? "null")
    : panic(`the page failed: ${page.error.message}`);

const originalFetch = globalThis.fetch;
const originalSleep = Bun.sleep;

beforeEach(() => {
  Bun.sleep = async () => {
    // The publisher gate paces against a live court; nothing here is live.
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Bun.sleep = originalSleep;
});

// ── Docket, dates and identity ───────────────────────────

describe("the docket", () => {
  test("a CNJ number is stored in the BRA grammar's form", () => {
    expect(
      brTjdftCaseNumberOf({ processo: "07532685320238070000" }, "id"),
    ).toEqual({
      caseNumber: "0753268-53.2023.8.07.0000",
      reading: { type: "cnj" },
    });
  });

  test("a pre-CNJ court number is kept as the court lists it", () => {
    for (const processo of ["20090020163473ARC", "APC1101"]) {
      expect(brTjdftCaseNumberOf({ processo }, "id")).toEqual({
        caseNumber: processo,
        reading: { type: "publisher-legacy" },
      });
    }
  });

  test("a record stating no process number is labelled by its id, flagged", () => {
    expect(brTjdftCaseNumberOf({}, uuidAt(1))).toEqual({
      caseNumber: uuidAt(1),
      reading: { type: "placeholder" },
    });
  });
});

describe("the court's calendar", () => {
  test("an instant reads as the day it is in Brasília, daylight saving included", () => {
    expect(brTjdftCalendarDay("2024-02-22T03:00:00.000Z")).toBe("2024-02-22");
    // Brasília kept summer time until 2019: midnight was 02:00 UTC.
    expect(brTjdftCalendarDay("1999-12-22T02:00:00.000Z")).toBe("1999-12-22");
    expect(brTjdftCalendarDay("2024-03-01T23:57:15.000Z")).toBe("2024-03-01");
    expect(brTjdftCalendarDay(null)).toBeUndefined();
  });

  test("the last closed day is the court's yesterday, not UTC's", () => {
    // 02:30 UTC on the 25th is still the 24th in Brasília.
    expect(brTjdftLastClosedDay(new Date("2026-10-25T02:30:00.000Z"))).toBe(
      "2026-10-23",
    );
    expect(brTjdftLastClosedDay(NOW)).toBe("2026-10-24");
  });
});

describe("what a stored decision keeps", () => {
  test("an electronic-process acórdão carries its record, both responses and a parsed document", async () => {
    const decision = await assembledDetail(
      "br-tjdft-detail-acordao-pje.json.gz",
    );
    expect(decision).toMatchObject({
      sourceDocumentId: "aaf2982b-44e3-4a3d-9b74-df1c8555a667",
      caseNumber: "0753268-53.2023.8.07.0000",
      court: "Tribunal de Justiça do Distrito Federal e dos Territórios",
      country: "BRA",
      language: "pt",
      decisionType: "acórdão",
      decisionDate: "2024-02-22",
      sourceUrl:
        "https://jurisdf.tjdft.jus.br/acordaos/aaf2982b-44e3-4a3d-9b74-df1c8555a667",
      documentUrl:
        "https://jurisdf.tjdft.jus.br/api/v1/pesquisa/download/aaf2982b-44e3-4a3d-9b74-df1c8555a667",
      judges: [{ role: "rapporteur", nameAsPrinted: "ESDRAS NEVES" }],
    });
    expect(decision.isListingOnly).toBeUndefined();
    expect(decision.textFields.headnote).toMatchObject({ type: "present" });
    expect(decision.metadata).toMatchObject({
      cnjClass: "AGRAVO DE EXECUÇÃO PENAL",
      cnjClassCode: 413,
      chamber: "1ª TURMA CRIMINAL",
      outcome: "NEGAR PROVIMENTO AO RECURSO. UNÂNIME",
      publicationVenue: "PJe",
      publicationDate: "2024-03-01",
      recordIdentifier: "1819614",
      textSource: "inteiroTeorHtml",
      caseNumberReading: "cnj",
    });
    const parts = decodeSourceRawEnvelope(decision.sourceRaw ?? "");
    expect(parts?.["detail"]).toBe(
      await fixtureText("br-tjdft-detail-acordao-pje.json.gz"),
    );
    expect(Object.keys(parts ?? {}).toSorted()).toEqual(["detail", "listing"]);
    expect(
      "blocks" in decision.documentAst ? decision.documentAst.blocks.length : 0,
    ).toBeGreaterThan(10);
    expect(decision.sections?.map(({ title }) => title)).toEqual(
      expect.arrayContaining(["EMENTA", "ACÓRDÃO", "RELATÓRIO", "VOTOS"]),
    );
  });

  test("a monocratic decision states no judgment date and no headnote apart from its text", async () => {
    const decision = await assembledDetail("br-tjdft-detail-decisao.json.gz");
    expect(String(decision.decisionType)).toBe("decisão monocrática");
    expect(decision.decisionDate).toBeUndefined();
    expect(JSON.stringify(decision.metadata["decisionDateAvailability"])).toBe(
      JSON.stringify({ status: "not-published-by-source" }),
    );
    expect(decision.textFields.headnote).toEqual({
      type: "absent",
      reason: "not_published",
    });
    expect(decision.fulltext).toContain("Vistos etc.");
  });

  test("each decisões subbase is typed as the court names it", async () => {
    const { rows } = await recordedAnswer("br-tjdft-listing-decisoes.json.gz");
    const types = new Map(
      rows.map((row) => [
        row["subbase"],
        assembleBrTjdftDecision({
          listing: row,
          detail: {
            record: row,
            raw: JSON.stringify({ hits: { value: 1 }, registros: [row] }),
          },
          detailStatus: undefined,
        }).decisionType,
      ]),
    );
    expect(Object.fromEntries(types)).toEqual({
      "decisoes-monocraticas": "decisão monocrática",
      "decisoes-presidencia": "decisão da presidência",
    });
  });

  test("a judgment with no published full text is read from its record", async () => {
    const decision = await assembledDetail(
      "br-tjdft-listing-acordao-1975.json.gz",
    );
    expect(JSON.stringify(decision.metadata["textSource"])).toBe('"record"');
    expect(String(decision.caseNumber)).toBe("APC5908");
    expect(JSON.stringify(decision.metadata["caseNumberReading"])).toBe(
      '"publisher-legacy"',
    );
    expect(decision.fulltext).toBe(
      "NULA É A CITAÇÃO EDITALÍCIA QUANDO COMPROVADA A FALSIDADE DA AFIRMAÇÃO DE AUSÊNCIA.\n\nPROVER O RECURSO ADESIVO E NÃO PROVER O DA APELANTE. DECISÃO UNÂNIME.",
    );
  });

  test("an outvoted rapporteur, the designated one and a revisor are all named", async () => {
    const designado = await assembledDetail(
      "br-tjdft-detail-acordao-designado.json.gz",
    );
    const named = (decision: IngestionResult) =>
      (decision.judges ?? []).map(
        ({ role, nameAsPrinted }) => `${role}: ${nameAsPrinted}`,
      );
    expect(named(designado)).toEqual([
      "rapporteur: FERNANDO TAVERNARD",
      "rapporteur: ARNOLDO CAMANHO DE ASSIS",
    ]);
    const revisor = await assembledDetail(
      "br-tjdft-detail-acordao-revisor.json.gz",
    );
    expect(named(revisor)).toContain("panel-member: SIMONE LUCINDO");
  });

  test("assembling the same responses twice is a fixed point", async () => {
    const first = await assembledDetail("br-tjdft-detail-acordao-pje.json.gz");
    const second = await assembledDetail("br-tjdft-detail-acordao-pje.json.gz");
    expect(second.rawHash).toBe(first.rawHash);
    expect(second.sourceRaw).toBe(first.sourceRaw);
  });

  test("a stored envelope replays into the decision the crawl stored", async () => {
    const stored = await assembledDetail(
      "br-tjdft-detail-acordao-2010.json.gz",
    );
    const replayed = await brTjdftAdapter.reparseStoredRaw?.({
      raw: new TextEncoder().encode(stored.sourceRaw ?? ""),
      contentType: stored.sourceRawContentType ?? null,
      caseNumber: stored.caseNumber,
      sourceDocumentId: stored.sourceDocumentId ?? null,
      language: stored.language,
      court: stored.court,
      ecli: null,
      decisionDate: stored.decisionDate ?? null,
      decisionType: stored.decisionType ?? null,
      sourceUrl: stored.sourceUrl ?? null,
      documentUrl: stored.documentUrl ?? null,
      metadata: stored.metadata,
    });
    expect(replayed?.type).toBe("parsed");
    if (replayed?.type === "parsed") {
      expect(replayed.result.rawHash).toBe(stored.rawHash);
      expect(replayed.result.documentAst).toEqual(stored.documentAst);
      expect(String(replayed.result.caseNumber)).toBe("20090020163473ARC");
    }
  });
});

// ── The crawl ────────────────────────────────────────────

describe("the crawl", () => {
  test("sends the court's own listing and detail requests", async () => {
    const calls = windowPublisher((base) =>
      base === "acordaos" ? [rowAt(0)] : [],
    );
    await adapter.fetchPage(cursorOf(), {});
    expect(calls.map(({ url, method }) => [url, method])).toEqual([
      [SEARCH_URL, "POST"],
      [SEARCH_URL, "POST"],
    ]);
    expect(calls[0]?.body).toEqual({
      query: "",
      termosAcessorios: [
        { campo: "base", valor: "acordaos" },
        { campo: "dataPublicacao", valor: "entre 2024-03-01 e 2024-03-01" },
      ],
      pagina: 0,
      tamanho: 40,
      espelho: false,
      inteiroTeor: false,
      sinonimos: false,
      retornaInteiroTeor: false,
      retornaTotalizacao: false,
    });
    expect(calls[1]?.body).toEqual({
      termosAcessorios: [{ campo: "uuid", valor: uuidAt(0) }],
      pagina: 0,
      tamanho: 1,
      espelho: false,
      inteiroTeor: false,
      sinonimos: false,
      retornaInteiroTeor: true,
      retornaTotalizacao: false,
    });
  });

  test("a record under judicial secrecy is neither read nor stored, and counts against the window", async () => {
    const { raw } = await recordedAnswer("br-tjdft-listing-acordaos.json.gz");
    const listing = readBrTjdftSearch(raw) ?? panic("unreadable fixture");
    const secret = listing.rows.filter((row) => row["segredoJustica"] === true);
    expect(secret.length).toBeGreaterThan(0);
    const calls = stubPublisher((call) =>
      isDetail(call)
        ? detailAnswer(
            listing.rows.find(
              (row) => row["uuid"] === termOf(call.body, "uuid"),
            ) ?? panic("detail for an unlisted id"),
          )
        : new Response(raw),
    );
    const page = await adapter.fetchPage(cursorOf(), {});
    const decisions = Result.isOk(page) ? page.value.decisions : [];
    expect(decisions).toHaveLength(listing.rows.length - secret.length);
    const read = new Set(
      calls.filter(isDetail).map(({ body }) => termOf(body, "uuid")),
    );
    for (const row of secret) {
      expect(read.has(String(row["uuid"]))).toBe(false);
      expect(
        decisions.some(
          ({ sourceDocumentId }) => sourceDocumentId === row["uuid"],
        ),
      ).toBe(false);
    }
    const next = nextCursorOf(page);
    expect(next).toMatchObject({
      page: 1,
      total: listing.total,
      excluded: secret.length,
    });
    // The secret rows are counted against the window, as ids.
    expect(next.seen).toHaveLength(listing.rows.length);
  });

  test("a window longer than one page is followed to its end, then to the next base", async () => {
    // Rule 14: a full page is never the end of a window; the count says so.
    const rows = Array.from({ length: BR_TJDFT_PAGE_SIZE + 5 }, (_, index) =>
      rowAt(index),
    );
    windowPublisher((base) => (base === "acordaos" ? rows : []));
    const first = await adapter.fetchPage(cursorOf(), {});
    expect(nextCursorOf(first)).toMatchObject({
      day: "2024-03-01",
      base: "acordaos",
      page: 1,
      total: rows.length,
    });
    expect(nextCursorOf(first).seen).toHaveLength(BR_TJDFT_PAGE_SIZE);
    const second = await adapter.fetchPage(
      JSON.stringify(nextCursorOf(first)),
      {},
    );
    expect(Result.isOk(second) ? second.value.decisions : []).toHaveLength(5);
    expect(nextCursorOf(second)).toMatchObject({
      day: "2024-03-01",
      base: "decisoes",
      page: 0,
      total: null,
    });
    const third = await adapter.fetchPage(
      JSON.stringify(nextCursorOf(second)),
      {},
    );
    expect(nextCursorOf(third)).toMatchObject({
      day: "2024-03-02",
      base: "acordaos",
    });
  });

  test("a window whose count moves while it is paged is walked again from its first page", async () => {
    const rows = Array.from({ length: BR_TJDFT_PAGE_SIZE + 5 }, (_, index) =>
      rowAt(index),
    );
    // A record published into the closed day between the two pages.
    windowPublisher(
      (base) => (base === "acordaos" ? rows : []),
      (base, page) => (base === "acordaos" ? rows.length + page : 0),
    );
    const first = await adapter.fetchPage(cursorOf(), {});
    const second = await adapter.fetchPage(
      JSON.stringify(nextCursorOf(first)),
      {},
    );
    expect(nextCursorOf(second)).toMatchObject({
      day: "2024-03-01",
      base: "acordaos",
      page: 0,
      total: null,
      restarts: 1,
    });
  });

  test("rows that do not add up to the count restart the window", async () => {
    // The first page comes back two rows short of a full page while the
    // count stays put: the order moved under the offsets.
    const total = BR_TJDFT_PAGE_SIZE + 5;
    stubPublisher((call) => {
      if (isDetail(call)) {
        return detailAnswer(
          rowAt(
            Number.parseInt(termOf(call.body, "uuid")?.slice(-12) ?? "0", 16),
          ),
        );
      }
      return Number(call.body["pagina"]) === 0
        ? answer(
            total,
            Array.from({ length: BR_TJDFT_PAGE_SIZE - 2 }, (_, index) =>
              rowAt(index),
            ),
          )
        : answer(
            total,
            Array.from({ length: 5 }, (_, index) =>
              rowAt(BR_TJDFT_PAGE_SIZE + index),
            ),
          );
    });
    const first = await adapter.fetchPage(cursorOf(), {});
    expect(nextCursorOf(first)).toMatchObject({ page: 1, total });
    expect(nextCursorOf(first).seen).toHaveLength(BR_TJDFT_PAGE_SIZE - 2);
    const second = await adapter.fetchPage(
      JSON.stringify(nextCursorOf(first)),
      {},
    );
    expect(nextCursorOf(second)).toMatchObject({
      base: "acordaos",
      page: 0,
      restarts: 1,
    });
  });

  test("an empty page below the count fails instead of ending the window", async () => {
    // Rule 14: only the count ends a window.
    stubPublisher(() => answer(BR_TJDFT_PAGE_SIZE + 1, []));
    const page = await adapter.fetchPage(cursorOf({ page: 1, total: 41 }), {});
    expect(Result.isError(page)).toBe(true);
  });

  test("a window that keeps moving is left to reconciliation after its restarts", async () => {
    windowPublisher(
      (base) => (base === "acordaos" ? [rowAt(0)] : []),
      (base) => (base === "acordaos" ? 2 : 0),
    );
    const last = await adapter.fetchPage(
      cursorOf({ page: 0, total: 1, restarts: 3 }),
      {},
    );
    expect(nextCursorOf(last)).toMatchObject({
      day: "2024-03-01",
      base: "decisoes",
      restarts: 0,
    });
  });

  test("a cycle with no closed day sends nothing and returns its cursor", async () => {
    const calls = stubPublisher(() => panic("no request is due"));
    const parked = cursorOf({ day: "2026-10-25" });
    const page = await adapter.fetchPage(parked, {});
    expect(calls).toHaveLength(0);
    expect(Result.isOk(page) ? page.value.nextCursor : null).toBe(parked);
  });

  test("the first cycle starts at the last closed day", () => {
    const start = parseBrTjdftCursor(null, NOW);
    expect(Result.isOk(start) ? start.value : null).toMatchObject({
      day: "2026-10-24",
      base: "acordaos",
      page: 0,
    });
  });

  test("a cursor this adapter did not write is refused", async () => {
    stubPublisher(() => panic("no request is due"));
    const page = await adapter.fetchPage('{"day":"2024-03-01"}', {});
    expect(Result.isError(page)).toBe(true);
  });

  test("an HTTP 200 that is not a search answer fails the page", async () => {
    stubPublisher(() => new Response("<html>manutenção</html>"));
    const page = await adapter.fetchPage(cursorOf(), {});
    expect(Result.isError(page)).toBe(true);
  });

  test("a rate-limit refusal of a detail halts the page after one request", async () => {
    const calls = stubPublisher((call) =>
      isDetail(call)
        ? new Response("", { status: 429, headers: { "Retry-After": "60" } })
        : answer(2, [rowAt(0), rowAt(1)]),
    );
    const page = await adapter.fetchPage(cursorOf(), {});
    expect(Result.isError(page)).toBe(true);
    expect(calls.filter(isDetail)).toHaveLength(1);
  });

  test("a detail the server fails to answer is an unread listed item, not a decision", async () => {
    stubPublisher((call) =>
      isDetail(call)
        ? new Response("erro", { status: 503 })
        : answer(1, [rowAt(0)]),
    );
    const page = await adapter.fetchPage(cursorOf(), {});
    const value = Result.isOk(page) ? page.value : panic("the page failed");
    expect(value.decisions).toHaveLength(0);
    expect(value.unreadItems).toHaveLength(1);
    expect(value.unreadItems?.[0]?.listing).toMatchObject({
      sourceDocumentId: uuidAt(0),
      isListingOnly: true,
    });
    expect(value.unreadItems?.[0]?.outcome.type).toBe("unavailable");
  });

  test("a listed record the detail no longer states is kept as a listing-only row", async () => {
    stubPublisher((call) =>
      isDetail(call) ? answer(0, []) : answer(1, [rowAt(0)]),
    );
    const page = await adapter.fetchPage(cursorOf(), {});
    const decision =
      (Result.isOk(page) ? page.value.decisions : []).at(0) ??
      panic("no decision");
    expect(decision).toMatchObject({
      sourceDocumentId: uuidAt(0),
      isListingOnly: true,
    });
    expect(JSON.stringify(decision.metadata["detailStatus"])).toBe(
      '"detail-absent"',
    );
    const parts = decodeSourceRawEnvelope(decision.sourceRaw ?? "");
    expect(Object.keys(parts ?? {})).toEqual(["listing"]);
  });

  test("a row stating no id is quarantined under its content, not dropped", async () => {
    const row = rowAt(0, { uuid: "not-a-uuid" });
    const calls = stubPublisher((call) =>
      isDetail(call) ? panic("no detail for an unkeyed row") : answer(1, [row]),
    );
    const page = await adapter.fetchPage(cursorOf(), {});
    const decision =
      (Result.isOk(page) ? page.value.decisions : []).at(0) ??
      panic("no decision");
    expect(decision.sourceDocumentId).toMatch(/^quarantine:[0-9a-f]{64}$/u);
    expect(decision.isListingOnly).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

// ── Reconciliation ───────────────────────────────────────

describe("the reconciliation slices", () => {
  const { reconciliation } = adapter;

  test("sort in walk order, day by day and base by base", () => {
    const walked = [
      brTjdftSlice("2024-02-29", "decisoes"),
      brTjdftSlice("2024-03-01", "acordaos"),
      brTjdftSlice("2024-03-01", "decisoes"),
    ];
    expect(walked.toSorted()).toEqual(walked);
    expect(reconciliation.nextSlice(walked[0] ?? "")).toBe(walked[1] ?? null);
    expect(reconciliation.nextSlice(walked[1] ?? "")).toBe(walked[2] ?? null);
    expect(reconciliation.previousSlice(walked[1] ?? "")).toBe(
      walked[0] ?? null,
    );
    expect(reconciliation.sliceOf(NOW)).toBe("2026-10-24:decisoes");
    expect(reconciliation.nextSlice("2026-10-24:decisoes")).toBeNull();
    expect(reconciliation.previousSlice(reconciliation.firstSlice)).toBeNull();
  });

  test("a slice lists what it holds, less the records under secrecy", async () => {
    const { raw, total, rows } = await recordedAnswer(
      "br-tjdft-listing-acordaos.json.gz",
    );
    stubPublisher(() => new Response(raw));
    const listed = await reconciliation.listSlicePage({
      slice: "2024-03-01:acordaos",
      page: 0,
    });
    // Each page twice: the records, then the ids again to verify them.
    expect(listed.totalPages).toBe(2 * Math.ceil(total / BR_TJDFT_PAGE_SIZE));
    expect(listed.items).toHaveLength(
      rows.filter((row) => row["segredoJustica"] !== true).length,
    );
    expect(listed.items[0]?.identity).toEqual({
      type: "document",
      sourceDocumentId: "aaf2982b-44e3-4a3d-9b74-df1c8555a667",
    });
  });

  test("a slice whose count moves while it is listed fails rather than records a count", async () => {
    let total = 41;
    stubPublisher((call) => {
      const page = Number(call.body["pagina"]);
      const rows = Array.from({ length: page === 0 ? 40 : 1 }, (_, index) =>
        rowAt(page * 40 + index),
      );
      return answer(total, rows);
    });
    await reconciliation.listSlicePage({
      slice: "2024-03-01:acordaos",
      page: 0,
    });
    total = 42;
    expect(
      await rejectionOf(
        reconciliation.listSlicePage({ slice: "2024-03-01:acordaos", page: 1 }),
      ),
    ).toMatchObject({ message: expect.stringContaining("changed its count") });
  });

  test("a slice whose distinct ids fall short of its count fails", async () => {
    // The second page repeats a row of the first: offset paging over an
    // order that moved.
    stubPublisher((call) =>
      Number(call.body["pagina"]) === 0
        ? answer(
            41,
            Array.from({ length: 40 }, (_, index) => rowAt(index)),
          )
        : answer(41, [rowAt(0)]),
    );
    await reconciliation.listSlicePage({
      slice: "2024-03-02:acordaos",
      page: 0,
    });
    expect(
      await rejectionOf(
        reconciliation.listSlicePage({ slice: "2024-03-02:acordaos", page: 1 }),
      ),
    ).toMatchObject({
      message: expect.stringContaining("40 distinct records for a count of 41"),
    });
  });

  test("a listed record is built through its detail", async () => {
    windowPublisher((base) => (base === "acordaos" ? [rowAt(7)] : []));
    const built = await reconciliation.buildDecision(rowAt(7));
    expect(built.type).toBe("built");
    expect(
      await reconciliation.buildDecision(rowAt(8, { segredoJustica: true })),
    ).toEqual({ type: "unkeyable" });
  });

  test("the revision ignores the row's position in the answer", () => {
    expect(reconciliation.revisionOf(rowAt(3, { sequencial: 1 }))).toEqual(
      reconciliation.revisionOf(rowAt(3, { sequencial: 9 })),
    );
  });
});

describe("the publisher", () => {
  test("is paced at no less than a second a request, as its rate limit asks", () => {
    expect(brTjdftAdapter.minRequestIntervalMs).toBe(
      publisherRequestIntervalMs(ADAPTER_KEYS.BR_TJDFT),
    );
    expect(brTjdftAdapter.minRequestIntervalMs).toBeGreaterThanOrEqual(1000);
  });

  test("its total is both bases less the acórdãos under secrecy", async () => {
    stubPublisher((call) => {
      if (termOf(call.body, "segredoJustica") === "true") {
        return answer(78, []);
      }
      return termOf(call.body, "base") === "acordaos"
        ? answer(1000, [])
        : answer(500, []);
    });
    expect(
      await brTjdftAdapter.getTotalCount(AbortSignal.timeout(5000)),
    ).toEqual({ type: "count", total: 1422 });
  });
});

// ── Secrecy, identity and slice shape ───────────────────

/** The detail answer for whichever synthetic row the request names. */
const syntheticDetail = (call: Call): Response =>
  detailAnswer(
    rowAt(Number.parseInt(termOf(call.body, "uuid")?.slice(-12) ?? "0", 16)),
  );

describe("secrecy stated only by the detail answer", () => {
  test("keeps the record out of the crawl and the reconciliation walk", async () => {
    // The listing row says public; the record itself says secret.
    const listed = rowAt(0);
    stubPublisher((call) =>
      isDetail(call)
        ? detailAnswer({ ...listed, segredoJustica: true })
        : answer(1, [listed]),
    );
    const page = await adapter.fetchPage(cursorOf(), {});
    const value = Result.isOk(page) ? page.value : panic("the page failed");
    expect(value.decisions).toHaveLength(0);
    expect(value.unreadItems ?? []).toHaveLength(0);
    expect(nextCursorOf(page)).toMatchObject({ base: "decisoes" });
    expect(await adapter.reconciliation.buildDecision(listed)).toEqual({
      type: "unkeyable",
    });
  });
});

describe("a window's identities", () => {
  test("a row listed twice under an unchanged count restarts the window", async () => {
    // The order moved between the pages: page 1 repeats A39 and A40 is never
    // listed, though the count and the number of rows both say 41.
    stubPublisher((call) => {
      if (isDetail(call)) {
        return syntheticDetail(call);
      }
      return Number(call.body["pagina"]) === 0
        ? answer(
            41,
            Array.from({ length: BR_TJDFT_PAGE_SIZE }, (_, index) =>
              rowAt(index),
            ),
          )
        : answer(41, [rowAt(BR_TJDFT_PAGE_SIZE - 1)]);
    });
    const first = await adapter.fetchPage(cursorOf(), {});
    const second = await adapter.fetchPage(
      JSON.stringify(nextCursorOf(first)),
      {},
    );
    expect(nextCursorOf(second)).toMatchObject({
      day: "2024-03-01",
      base: "acordaos",
      page: 0,
      restarts: 1,
    });
  });
});

describe("a reconciliation slice's identities", () => {
  /** Lists every page the slice states, as the engine does. */
  const walkSlice = async (slice: string) => {
    const items: string[] = [];
    let totalPages = 1;
    for (let page = 0; page < totalPages; page += 1) {
      const listed = await adapter.reconciliation.listSlicePage({
        slice,
        page,
      });
      totalPages = listed.totalPages;
      for (const { identity } of listed.items) {
        items.push(
          identity.type === "document" ? identity.sourceDocumentId : "",
        );
      }
    }
    return items;
  };

  test("a slice whose membership changed under an unchanged count is not recorded", async () => {
    // A0 withdrawn and X published ahead of it between the passes: the count
    // stays 41 and the first pass alone reads as complete.
    const replacement = rowAt(500);
    let listings = 0;
    stubPublisher((call) => {
      const page = Number(call.body["pagina"]);
      const pass = Math.floor(listings / 2);
      listings += 1;
      if (page === 1) {
        return answer(41, [rowAt(BR_TJDFT_PAGE_SIZE)]);
      }
      const rows = Array.from({ length: BR_TJDFT_PAGE_SIZE }, (_, index) =>
        rowAt(index),
      );
      return answer(41, pass === 0 ? rows : [replacement, ...rows.slice(1)]);
    });
    expect(await rejectionOf(walkSlice("2024-03-03:acordaos"))).toMatchObject({
      message: expect.stringContaining("changed its records"),
    });
  });

  test("a slice listed twice alike is recorded once, with every record", async () => {
    windowPublisher((base) =>
      base === "acordaos"
        ? Array.from({ length: 41 }, (_, index) => rowAt(index))
        : [],
    );
    const items = await walkSlice("2024-03-04:acordaos");
    expect(items).toHaveLength(41);
    expect(new Set(items).size).toBe(41);
  });
});

describe("a row that recovers its publisher id", () => {
  test("names its quarantine row as a repair alias", () => {
    const malformed = assembleBrTjdftDecision({
      listing: rowAt(0, { uuid: "not-a-uuid" }),
      detail: undefined,
      detailStatus: "no-publisher-identity",
    });
    const recovered = assembleBrTjdftDecision({
      listing: rowAt(0),
      detail: {
        record: rowAt(0),
        raw: JSON.stringify({ hits: { value: 1 }, registros: [rowAt(0)] }),
      },
      detailStatus: undefined,
    });
    const quarantineId = malformed.sourceDocumentId ?? panic("no identity");
    expect(quarantineId).toMatch(/^quarantine:/u);
    expect(recovered.sourceDocumentIdRepairAliases).toEqual([quarantineId]);
  });
});

describe("the reconciliation history", () => {
  const { reconciliation } = adapter;

  test("is walked in years before 1960 and in months before 2000", () => {
    expect(reconciliation.firstSlice).toBe("1900:acordaos");
    expect(reconciliation.previousSlice("2000-01-01:acordaos")).toBe(
      "1999-12:decisoes",
    );
    expect(reconciliation.nextSlice("1999-12:decisoes")).toBe(
      "2000-01-01:acordaos",
    );
    expect(reconciliation.previousSlice("1960-01:acordaos")).toBe(
      "1959:decisoes",
    );
    expect(reconciliation.nextSlice("1959:decisoes")).toBe("1960-01:acordaos");
    const walked: string[] = [];
    let slice: string | null = reconciliation.sliceOf(NOW);
    while (slice !== null) {
      walked.push(slice);
      slice = reconciliation.previousSlice(slice);
    }
    expect(walked.at(-1)).toBe(reconciliation.firstSlice);
    expect(walked.toReversed()).toEqual(walked.toSorted());
    // Daily slices from 1900 would be over 92,000.
    expect(walked.length).toBeLessThan(21_000);
  });

  test("a month slice asks for its whole month", async () => {
    const calls = stubPublisher(() => answer(0, []));
    await reconciliation.listSlicePage({ slice: "1999-02:acordaos", page: 0 });
    expect(termOf(calls[0]?.body ?? {}, "dataPublicacao")).toBe(
      "entre 1999-02-01 e 1999-02-28",
    );
  });
});
