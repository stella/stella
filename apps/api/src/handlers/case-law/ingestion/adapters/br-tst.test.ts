/**
 * br-tst against records the TST search served, and its walk against a
 * scripted search.
 *
 * The recordings sit beside provenance sidecars, so a changed byte fails the
 * capture suite rather than quietly changing what these assertions are about.
 * Everything the walk does beyond reading one response (paging a window to its
 * stated count, restarting a window whose count moved, splitting a day past
 * the offset ceiling, standing still when parked, halting on a refusal) runs
 * through a stubbed transport: the behaviour under test is the cursor's.
 */
import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import { compareCodeUnit } from "@stll/collation";
import { INGESTION_STOP_KIND } from "@stll/legal-atlas/ingestion-cycle";
import { Temporal } from "@stll/time";

import {
  decodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import {
  BR_TST_HELD_LISTINGS,
  BR_TST_LISTING_PAGE_SIZE,
  BR_TST_MUTABLE_DAYS,
  BR_TST_OFFSET_CEILING,
  BR_TST_PLACEHOLDER,
  BR_TST_PLACEHOLDER_FIELDS,
  brTstAdapter,
  brTstFetchPage,
  brTstLastClosedDay,
  brTstQuarantineId,
  brTstSearchBody,
  buildBrTstDecision,
  createBrTstSliceLister,
  encodeBrTstCursor,
  parseBrTstCursor,
} from "@/api/handlers/case-law/ingestion/adapters/br-tst";
import type { BrTstCursor } from "@/api/handlers/case-law/ingestion/adapters/br-tst";
import { rejectionOf } from "@/api/handlers/case-law/ingestion/adapters/test-utils";
import {
  listReconciliationSlice,
  MAX_SLICE_PAGES,
} from "@/api/handlers/case-law/ingestion/slice-listing";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { BR_TST_PRECEDENTS_SLICE } from "@/api/lib/legal-search/ingestion-constants";
import { isRecord } from "@/api/lib/type-guards";
import {
  BR_TST_RECORDINGS,
  brTstRecordedRecords,
} from "@/api/tests/helpers/case-law-enrolled-fixtures";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Noon in Brasília on 2026-10-25: the 24th is the last closed day. */
const NOW = Temporal.Instant.from("2026-10-25T15:00:00Z");

const built = (record: Record<string, unknown>): IngestionResult => {
  const outcome = buildBrTstDecision(record);
  expect(outcome.type).toBe("built");
  return outcome.decision;
};

/** The row's metadata and docket, read as the plain values they hold. */
const metadataOf = (
  decision: IngestionResult,
): Readonly<Record<string, unknown>> => decision.metadata;
const caseNumberOf = (decision: IngestionResult): string => decision.caseNumber;
/** A branded row value, compared as the plain value it holds. */
const observed = (value: unknown): unknown => value;

const firstRecord = async (
  name: (typeof BR_TST_RECORDINGS)[number],
): Promise<Record<string, unknown>> => {
  const [record] = await brTstRecordedRecords(name);
  if (record === undefined) {
    throw new TypeError(`${name} holds no record`);
  }
  return record;
};

// ── Records ──────────────────────────────────────────────

describe("a recorded acórdão", () => {
  test("is keyed by its type and id, filed under the CNJ number, and dated by its judgment", async () => {
    const record = await firstRecord("br-tst-acordao-2024.json");
    const decision = built(record);
    expect(decision.sourceDocumentId).toBe(`ACORDAO:${String(record["id"])}`);
    expect(caseNumberOf(decision)).toBe("0000404-14.2012.5.04.0028");
    expect(observed(decision.decisionType)).toBe("acórdão");
    expect(decision.decisionDate).toBe(String(record["dtaJulgamento"]));
    expect(observed(decision.court)).toBe("Tribunal Superior do Trabalho");
    expect(decision.country).toBe("BRA");
    expect(decision.language).toBe("pt");
    expect(observed(decision.judges)).toEqual([
      { role: "rapporteur", nameAsPrinted: String(record["nomRelator"]) },
    ]);
    expect(metadataOf(decision)["docketReading"]).toEqual({
      type: "docket",
      formatted: "0000404-14.2012.5.04.0028",
      field: "numFormatado",
    });
    // The class the docket is filed under stays on the row beside it.
    expect(metadataOf(decision)["processClass"]).toBe("Ag-RR");
    expect(metadataOf(decision)["numFormatado"]).toBe(record["numFormatado"]);
    expect(observed(decision.textFields.headnote)).toEqual({
      type: "present",
      text: String(record["ementa"]).trim(),
    });
    expect(metadataOf(decision)["dispositivo"]).toBe(record["dispositivo"]);
    expect(decision.documentUrl).toStartWith(
      "https://consultadocumento.tst.jus.br/consultaDocumento/acordao.do?",
    );
    expect(decision.fulltext?.length ?? 0).toBeGreaterThan(1000);
  });

  test("never carries the signatory's tax id, in the row or in what it stores", async () => {
    const record = await firstRecord("br-tst-acordao-2024.json");
    const served = String(record["codCPFSignatario"]);
    expect(served).toMatch(/^\d{11}$/u);
    const decision = built(record);
    expect(Object.hasOwn(metadataOf(decision), "codCPFSignatario")).toBe(false);
    expect(decision.sourceRaw ?? "").not.toContain(served);
    expect(decision.sourceRawContentType).toBe(
      SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    );
  });

  test("stores the record verbatim but for the dropped field", async () => {
    const record = await firstRecord("br-tst-acordao-2024.json");
    const parts = decodeSourceRawEnvelope(built(record).sourceRaw ?? "");
    expect(JSON.parse(parts?.["listing"] ?? "null")).toEqual({
      ...record,
      codCPFSignatario: null,
    });
  });

  test("reads no placeholder as text and keeps none as metadata", async () => {
    const record = await firstRecord("br-tst-acordao-2024.json");
    expect(record["ementaHtml"]).toBe(BR_TST_PLACEHOLDER);
    const decision = built(record);
    for (const field of BR_TST_PLACEHOLDER_FIELDS) {
      expect(Object.hasOwn(metadataOf(decision), field)).toBe(false);
    }
    expect(JSON.stringify(decision.documentAst)).not.toContain(
      BR_TST_PLACEHOLDER,
    );
  });

  test("a placeholder where the headnote should be is an absent headnote", async () => {
    const record = await firstRecord("br-tst-acordao-2024.json");
    const decision = built({ ...record, ementa: BR_TST_PLACEHOLDER });
    expect(observed(decision.textFields.headnote)).toEqual({
      type: "absent",
      reason: "publisher_placeholder",
    });
  });

  test("a print with no class reads its docket from the twenty digits", async () => {
    const record = await firstRecord("br-tst-acordao-1985.json");
    expect(String(record["numFormatado"]).trim()).toStartWith("-");
    const decision = built(record);
    expect(caseNumberOf(decision)).toBe("0003823-11.1984.5.55.5555");
    expect(metadataOf(decision)["docketReading"]).toEqual({
      type: "docket",
      formatted: "0003823-11.1984.5.55.5555",
      field: "numero",
    });
  });

  test("a docket neither field states is kept as printed, never defaulted", async () => {
    const record = await firstRecord("br-tst-acordao-2024.json");
    const decision = built({ ...record, numFormatado: "XYZ 12", numero: "12" });
    expect(caseNumberOf(decision)).toBe("XYZ 12");
    expect(metadataOf(decision)["docketReading"]).toEqual({
      type: "refused",
      printed: "XYZ 12",
    });
  });
});

describe("a recorded despacho", () => {
  test("is a despacho, as the court names it, with no decision date the record states", async () => {
    for (const name of [
      "br-tst-despacho-2020.json",
      "br-tst-despacho-2024.json",
    ] as const) {
      for (const record of await brTstRecordedRecords(name)) {
        const decision = built(record);
        expect(decision.sourceDocumentId).toBe(
          `DESPACHO:${String(record["id"])}`,
        );
        expect(observed(decision.decisionType)).toBe("despacho");
        expect(decision.decisionDate).toBeUndefined();
        expect(metadataOf(decision)["decisionDateAvailability"]).toEqual({
          status: "not-published-by-source",
        });
        expect(decision.fulltext?.length ?? 0).toBeGreaterThan(100);
        expect(decision.documentUrl).toStartWith(
          "https://consultadocumento.tst.jus.br/consultaDocumento/despacho.do?",
        );
      }
    }
  });
});

describe("a recorded precedent", () => {
  test("takes the court's short label, built from its own type, chamber and number", async () => {
    const labels = [];
    for (const name of [
      "br-tst-sumula.json",
      "br-tst-orientacao.json",
      "br-tst-orientacao-transitoria.json",
      "br-tst-precedente-normativo.json",
    ] as const) {
      for (const record of await brTstRecordedRecords(name)) {
        const decision = built(record);
        labels.push([
          decision.caseNumber,
          decision.decisionType,
          decision.sourceDocumentId,
        ]);
        expect(decision.documentAst).toHaveProperty("blocks");
      }
    }
    expect(labels).toEqual([
      ["SUM-1", "súmula", "SUM:201"],
      ["SUM-2", "súmula", "SUM:78"],
      ["OJ-SDC-1", "orientação jurisprudencial", "OJ:67"],
      ["OJ-SDI2-1", "orientação jurisprudencial", "OJ:661"],
      ["OJT-SDI1-1", "orientação jurisprudencial transitória", "OJT:1481"],
      ["OJT-SDI1-2", "orientação jurisprudencial transitória", "OJT:1482"],
      ["PN-1", "precedente normativo", "PN:141"],
      ["PN-2", "precedente normativo", "PN:142"],
    ]);
  });
});

describe("a record this adapter cannot build", () => {
  test("of an unknown type stays a listing-only row under its identity", () => {
    const outcome = buildBrTstDecision({
      id: "abc",
      tipo: { codigoTipoJurisprudencia: "NOVO", nome: "Novo" },
      orgao: { nome: "Tribunal Superior do Trabalho" },
    });
    expect(outcome.type).toBe("unbuildable");
    expect(outcome.decision.sourceDocumentId).toBe("NOVO:abc");
    expect(outcome.decision.isListingOnly).toBe(true);
  });

  test("with no identity is quarantined under its content, never dropped", () => {
    const record = {
      tipo: { codigoTipoJurisprudencia: "ACORDAO" },
      orgao: { nome: "TST" },
    };
    const first = buildBrTstDecision(record);
    expect(first.type).toBe("unbuildable");
    expect(first.decision.sourceDocumentId).toStartWith("quarantine:");
    expect(buildBrTstDecision(record).decision.sourceDocumentId).toBe(
      first.decision.sourceDocumentId,
    );
  });
});

// ── Source fields ────────────────────────────────────────

describe("the source-field inventory", () => {
  test("is exactly the union of what every recorded record type states", async () => {
    const { sourceFields } = brTstAdapter;
    const stated = new Set<string>();
    for (const name of BR_TST_RECORDINGS) {
      for (const record of await brTstRecordedRecords(name)) {
        const decision = buildBrTstDecision(record).decision;
        const parts = decodeSourceRawEnvelope(decision.sourceRaw ?? "") ?? {};
        const fields = await sourceFields.listSourceFields(parts);
        for (const field of fields) {
          expect(sourceFields.fields[field], `${name}: ${field}`).toBeDefined();
          stated.add(field);
        }
      }
    }
    expect([...stated].toSorted()).toEqual(
      Object.keys(sourceFields.fields).toSorted(),
    );
  });
});

// ── The walk ─────────────────────────────────────────────

type Call = { start: number; size: number; body: Record<string, unknown> };

const responseOf = (
  reported: number,
  records: readonly Record<string, unknown>[],
): Response =>
  new Response(
    JSON.stringify({
      tempoGasto: 1,
      totalRegistros: reported,
      registros: records.map((registro) => ({ registro, destaques: {} })),
      agregacoes: [],
    }),
    { headers: { "Content-Type": "application/json" } },
  );

const urlOf = (input: string | URL | Request): string => {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
};

/** Script the search and record every request the walk sent. */
const stubSearch = (answer: (call: Call) => Response): Call[] => {
  const calls: Call[] = [];
  globalThis.fetch = asFetchMock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const match = /\/rest\/pesquisa-textual\/(\d+)\/(\d+)$/u.exec(
        urlOf(input),
      );
      const body: unknown = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      );
      const call = {
        start: Number(match?.[1]),
        size: Number(match?.[2]),
        body: isRecord(body) ? body : {},
      };
      calls.push(call);
      return await Promise.resolve(answer(call));
    },
  );
  return calls;
};

/** A day window holding `count` synthetic acórdãos, served by offset. */
const dayOf = (count: number, prefix = "a") => {
  const template = {
    tipo: { codigoTipoJurisprudencia: "ACORDAO", nome: "Acordão" },
    orgao: { numero: 0, nome: "Tribunal Superior do Trabalho", sigla: "TST" },
    numFormatado: "RR - 1000-10.2020.5.01.0001",
    dtaJulgamento: "2024-03-06",
    inteiroTeorHtml:
      "<html><body><p class=default>Conheço do recurso.</p></body></html>",
  };
  return Array.from({ length: count }, (_, index) => ({
    ...template,
    id: `${prefix}${String(index).padStart(31, "0")}`,
  }));
};

const serve =
  (rows: readonly Record<string, unknown>[], reported = rows.length) =>
  ({ start, size }: Call): Response =>
    responseOf(reported, rows.slice(start - 1, start - 1 + size));

const cursorOf = (
  page: Result<{ nextCursor: string | null }, unknown>,
): BrTstCursor => {
  if (!Result.isOk(page) || page.value.nextCursor === null) {
    throw new TypeError("the page did not advance");
  }
  const parsed = parseBrTstCursor(page.value.nextCursor);
  if (Result.isError(parsed)) {
    throw parsed.error;
  }
  return parsed.value;
};

const walkAt = (day: string, offset = 0): string =>
  encodeBrTstCursor({
    phase: "walk",
    regime: "sweep",
    window: { type: "day", day, part: "all" },
    offset,
  });

describe("the walk", () => {
  test("starts on the precedents, listed by number, before the first day", async () => {
    const calls = stubSearch(() => responseOf(0, []));
    const page = await brTstFetchPage(null, { now: NOW });
    expect(Result.isOk(page)).toBe(true);
    expect(calls.at(0)?.body).toMatchObject({
      tipos: ["SUM", "OJ", "OJT", "PN"],
      ordenacao: "numero",
      publicacaoInicial: "",
    });
    // Empty windows are stepped over within the page, oldest day first.
    expect(calls.at(1)?.body).toMatchObject({
      tipos: [],
      ordenacao: "data",
      publicacaoInicial: "1985-01-01",
      publicacaoFinal: "1985-01-01",
    });
  });

  test("follows a window past its page boundaries to the count it states", async () => {
    const rows = dayOf(45);
    const calls = stubSearch(serve(rows));
    let cursor = walkAt("2024-03-15");
    const seen: string[] = [];
    for (let step = 0; step < 3; step += 1) {
      const page = await brTstFetchPage(cursor, { now: NOW });
      if (!Result.isOk(page)) {
        throw page.error;
      }
      seen.push(
        ...page.value.decisions.map(
          ({ sourceDocumentId }) => sourceDocumentId ?? "",
        ),
      );
      cursor = page.value.nextCursor ?? "";
    }
    expect(calls.slice(0, 3).map(({ start, size }) => [start, size])).toEqual([
      [1, 20],
      [21, 20],
      [41, 20],
    ]);
    expect(new Set(seen).size).toBe(45);
    // The window is done because its count is reached, not because a page
    // was short: the walk is on the next day.
    expect(parseBrTstCursor(cursor).unwrap()).toMatchObject({
      phase: "walk",
      regime: "sweep",
      window: { type: "day", day: "2024-03-16" },
    });
  });

  test("a short page before the stated count is a failure, not the end", async () => {
    stubSearch(serve(dayOf(15), 45));
    const page = await brTstFetchPage(walkAt("2024-03-15"), { now: NOW });
    expect(Result.isError(page)).toBe(true);
  });

  test("a window whose count moved is read again from its start", async () => {
    const rows = dayOf(45);
    stubSearch(serve(rows, 46));
    const page = await brTstFetchPage(
      encodeBrTstCursor({
        phase: "walk",
        regime: "sweep",
        window: { type: "day", day: "2024-03-15", part: "all" },
        offset: 20,
        reported: 45,
      }),
      { now: NOW },
    );
    expect(Result.isOk(page) && page.value.decisions).toEqual([]);
    expect(cursorOf(page)).toEqual({
      phase: "walk",
      regime: "sweep",
      window: { type: "day", day: "2024-03-15", part: "all" },
      offset: 0,
    });
  });

  test("never walks the publisher's current day, and parks on the last closed one", async () => {
    expect(brTstLastClosedDay(NOW)).toBe("2026-10-24");
    // 02:00 UTC is still the 24th in Brasília.
    expect(
      brTstLastClosedDay(Temporal.Instant.from("2026-10-25T02:00:00Z")),
    ).toBe("2026-10-23");
    stubSearch(serve(dayOf(3)));
    const page = await brTstFetchPage(walkAt("2026-10-24"), { now: NOW });
    expect(cursorOf(page)).toEqual({ phase: "parked", through: "2026-10-24" });
  });

  test("parked with no newly closed day costs no request and returns its cursor", async () => {
    const calls = stubSearch(() => responseOf(0, []));
    const parked = encodeBrTstCursor({
      phase: "parked",
      through: "2026-10-24",
    });
    const page = await brTstFetchPage(parked, { now: NOW });
    expect(calls).toHaveLength(0);
    expect(Result.isOk(page) && page.value).toEqual({
      decisions: [],
      nextCursor: parked,
    });
  });

  test("parked, a newly closed day is walked once", async () => {
    const calls = stubSearch(serve(dayOf(2)));
    const page = await brTstFetchPage(
      encodeBrTstCursor({ phase: "parked", through: "2026-10-23" }),
      { now: NOW },
    );
    expect(calls.map(({ body }) => body["publicacaoInicial"])).toEqual([
      "2026-10-24",
    ]);
    expect(Result.isOk(page) && page.value.decisions).toHaveLength(2);
    expect(cursorOf(page)).toEqual({ phase: "parked", through: "2026-10-24" });
  });

  test("a day past the offset ceiling is walked one record type at a time", async () => {
    const calls = stubSearch(({ body }) => {
      const tipos = body["tipos"];
      if (Array.isArray(tipos) && tipos.length === 0) {
        return responseOf(BR_TST_OFFSET_CEILING + 1, dayOf(20));
      }
      return Array.isArray(tipos) && tipos.includes("ACORDAO")
        ? responseOf(3, dayOf(3, "b"))
        : responseOf(0, []);
    });
    const page = await brTstFetchPage(walkAt("2024-03-15"), { now: NOW });
    expect(calls.map(({ body }) => body["tipos"])).toEqual([[], ["ACORDAO"]]);
    expect(Result.isOk(page) && page.value.decisions).toHaveLength(3);
    expect(cursorOf(page)).toEqual({
      phase: "walk",
      regime: "sweep",
      window: { type: "day", day: "2024-03-15", part: "despacho" },
      offset: 0,
      split: { dayTotal: BR_TST_OFFSET_CEILING + 1, partsTotal: 3 },
    });
  });

  test("a rate-limit refusal halts the cycle after one request, cursor untouched", async () => {
    const calls = stubSearch(() => new Response("", { status: 429 }));
    const cursor = walkAt("2024-03-15");
    const page = await brTstAdapter.fetchPage(cursor, {});
    expect(calls).toHaveLength(1);
    expect(Result.isError(page)).toBe(true);
    if (Result.isError(page)) {
      expect(page.error.stopKind).toBe(INGESTION_STOP_KIND.PUBLISHER_REFUSAL);
    }
  });

  test("a server error is the page's failure after one request, never retried", async () => {
    const calls = stubSearch(() => new Response("", { status: 500 }));
    const page = await brTstFetchPage(walkAt("2024-03-15"), { now: NOW });
    expect(calls).toHaveLength(1);
    expect(Result.isError(page) && page.error).toBeInstanceOf(
      AdapterFetchError,
    );
  });

  test("an answer that is not the search's envelope is a failure", async () => {
    stubSearch(() => new Response("<html>manutenção</html>", { status: 200 }));
    const page = await brTstFetchPage(walkAt("2024-03-15"), { now: NOW });
    expect(Result.isError(page)).toBe(true);
  });

  test("the search body states every field the backend requires", () => {
    expect(
      Object.keys(
        JSON.parse(
          brTstSearchBody({ type: "day", day: "2024-03-15", part: "all" }),
        ),
      ),
    ).toEqual([
      "ou",
      "e",
      "termoExato",
      "naoContem",
      "ementa",
      "dispositivo",
      "numeracaoUnica",
      "orgaosJudicantes",
      "ministros",
      "convocados",
      "classesProcessuais",
      "codigosClassesPrecedentes",
      "indicadores",
      "assuntos",
      "tipos",
      "orgao",
      "publicacaoInicial",
      "publicacaoFinal",
      "julgamentoInicial",
      "julgamentoFinal",
      "ordenacao",
    ]);
  });
});

// ── Reconciliation ───────────────────────────────────────

const listSlice = async (slice: string) => {
  const { reconciliation } = brTstAdapter;
  return await listReconciliationSlice({
    adapterKey: brTstAdapter.key,
    listSlicePage: reconciliation.listSlicePage,
    slice,
    pageDelayMs: 0,
    pageTimeoutMs: 5000,
    sleep: async () => {
      await Promise.resolve();
    },
  });
};

describe("reconciliation", () => {
  test("its page covers the offset ceiling within the shared listing's page cap", () => {
    expect(BR_TST_LISTING_PAGE_SIZE * MAX_SLICE_PAGES).toBeGreaterThanOrEqual(
      BR_TST_OFFSET_CEILING,
    );
  });

  test("slices sort in walk order, the precedents first", () => {
    const { reconciliation } = brTstAdapter;
    expect(reconciliation.firstSlice).toBe(BR_TST_PRECEDENTS_SLICE);
    const firstDay = reconciliation.nextSlice(BR_TST_PRECEDENTS_SLICE) ?? "";
    expect(firstDay).toBe("1985-01-01");
    expect(reconciliation.previousSlice("1985-01-01")).toBe(
      BR_TST_PRECEDENTS_SLICE,
    );
    expect(reconciliation.previousSlice(BR_TST_PRECEDENTS_SLICE)).toBeNull();
    // The ledger orders slices as strings, so walk order is string order.
    expect(
      [firstDay, BR_TST_PRECEDENTS_SLICE].toSorted(compareCodeUnit),
    ).toEqual([BR_TST_PRECEDENTS_SLICE, firstDay]);
    expect(reconciliation.previousSlice("2024-03-01")).toBe("2024-02-29");
  });

  test("lists a day whole and holds it to the count the publisher states", async () => {
    const rows = dayOf(120);
    const calls = stubSearch(serve(rows));
    const listed = await listSlice("2024-03-15");
    expect(Result.isOk(listed) && listed.value.keyed.size).toBe(120);
    // One count, then pages of the listing size.
    expect(calls.map(({ start, size }) => [start, size])).toEqual([
      [1, 0],
      [1, BR_TST_LISTING_PAGE_SIZE],
      [51, BR_TST_LISTING_PAGE_SIZE],
      [101, 20],
    ]);
  });

  test("a listing that repeats rows and so misses others fails rather than settling", async () => {
    const rows = dayOf(60);
    // The second page repeats the first: a reordering between requests.
    stubSearch(({ start, size }) =>
      responseOf(
        60,
        start === 51
          ? rows.slice(0, size)
          : rows.slice(start - 1, start - 1 + size),
      ),
    );
    const error = await rejectionOf(listSlice("2024-03-15"));
    expect(error).toBeInstanceOf(AdapterFetchError);
    expect(error instanceof Error ? error.message : "").toContain(
      "listed 50 distinct records of the 60",
    );
  });

  test("a count that moves while the slice is listed fails the slice", async () => {
    const rows = dayOf(60);
    stubSearch(({ start, size }) =>
      responseOf(
        start === 51 ? 61 : 60,
        rows.slice(start - 1, start - 1 + size),
      ),
    );
    const error = await rejectionOf(listSlice("2024-03-15"));
    expect(error).toBeInstanceOf(AdapterFetchError);
  });

  test("the precedents slice lists the precedent set by number", async () => {
    const calls = stubSearch(() => responseOf(0, []));
    await listSlice(BR_TST_PRECEDENTS_SLICE);
    expect(calls.at(0)?.body).toMatchObject({
      tipos: ["SUM", "OJ", "OJT", "PN"],
      ordenacao: "numero",
    });
  });

  test("a payload is the record without the signatory's tax id, and builds the decision", async () => {
    const record = await firstRecord("br-tst-acordao-2024.json");
    stubSearch(() => responseOf(1, [record]));
    const listed = await listSlice("2024-03-15");
    const item = Result.isOk(listed)
      ? [...listed.value.keyed.values()].at(0)
      : undefined;
    expect(
      isRecord(item?.payload) && item.payload["codCPFSignatario"],
    ).toBeNull();
    const outcome = await brTstAdapter.reconciliation.buildDecision(
      item?.payload,
    );
    expect(outcome.type === "built" && outcome.decision.sourceDocumentId).toBe(
      `ACORDAO:${String(record["id"])}`,
    );
  });

  test("a revision ignores the reindexing stamp and the sort key", async () => {
    const record = await firstRecord("br-tst-acordao-2024.json");
    const { revisionOf } = brTstAdapter.reconciliation;
    expect(
      revisionOf({ ...record, dtaAtualizacao: "2030-01-01T00:00:00-03" }),
    ).toEqual(revisionOf(record));
    expect(revisionOf({ ...record, dispositivo: "outro" })).not.toEqual(
      revisionOf(record),
    );
  });
});

// ── Review fixes ─────────────────────────────────────────

type SliceLister = ReturnType<typeof createBrTstSliceLister>;

const listWith = async (lister: SliceLister, slice: string) =>
  await listReconciliationSlice({
    adapterKey: brTstAdapter.key,
    listSlicePage: lister.listSlicePage,
    slice,
    pageDelayMs: 0,
    pageTimeoutMs: 5000,
    sleep: async () => {
      await Promise.resolve();
    },
  });

const tiposOf = (call: Call): unknown[] => {
  const tipos = call.body["tipos"];
  return Array.isArray(tipos) ? tipos : [];
};

describe("a split day's reconciliation", () => {
  test("lists every part within the shared listing's page cap", async () => {
    const acordaos = dayOf(6000, "a");
    const despachos = dayOf(6000, "d");
    const calls = stubSearch((call) => {
      const tipos = tiposOf(call);
      if (tipos.length === 0) {
        return responseOf(12_000, []);
      }
      if (tipos.includes("ACORDAO")) {
        return serve(acordaos)(call);
      }
      return tipos.includes("DESPACHO")
        ? serve(despachos)(call)
        : responseOf(0, []);
    });
    const lister = createBrTstSliceLister({ now: () => NOW });
    const listed = await listWith(lister, "2024-03-15");
    expect(Result.isOk(listed) && listed.value.keyed.size).toBe(12_000);
    // One count of the day, one per part, and the pages.
    expect(calls.length).toBeLessThanOrEqual(4 + MAX_SLICE_PAGES);
  });
});

describe("the frontier", () => {
  test("a day whose count keeps moving is read to its end, not restarted", async () => {
    const rows = dayOf(100);
    const calls = stubSearch(({ start, size }) =>
      responseOf(45 + calls.length, rows.slice(start - 1, start - 1 + size)),
    );
    let cursor = encodeBrTstCursor({ phase: "parked", through: "2026-10-23" });
    const seen = new Set<string>();
    for (let step = 0; step < 10; step += 1) {
      const page = await brTstFetchPage(cursor, { now: NOW });
      if (!Result.isOk(page)) {
        throw page.error;
      }
      for (const { sourceDocumentId } of page.value.decisions) {
        seen.add(sourceDocumentId ?? "");
      }
      cursor = page.value.nextCursor ?? "";
      if (parseBrTstCursor(cursor).unwrap().phase === "parked") {
        break;
      }
    }
    expect(parseBrTstCursor(cursor).unwrap()).toEqual({
      phase: "parked",
      through: "2026-10-24",
    });
    expect(seen.size).toBeGreaterThan(40);
  });

  test("a resumed parked walk is on the frontier", async () => {
    const rows = dayOf(45);
    stubSearch(serve(rows));
    const page = await brTstFetchPage(
      encodeBrTstCursor({ phase: "parked", through: "2026-10-23" }),
      { now: NOW },
    );
    expect(cursorOf(page)).toMatchObject({ phase: "walk", regime: "frontier" });
  });
});

describe("a slice the court can still change", () => {
  test("is listed twice, and a record replaced between the passes fails it", async () => {
    const first = dayOf(60);
    const second = first.map((row, index) =>
      index === 5 ? { ...row, id: "replaced00000000000000000000000000" } : row,
    );
    let firstPassDone = false;
    stubSearch(({ start, size }) => {
      const rows = firstPassDone ? second : first;
      if (size > 0 && start - 1 + size >= first.length) {
        firstPassDone = true;
      }
      return responseOf(60, rows.slice(start - 1, start - 1 + size));
    });
    const lister = createBrTstSliceLister({ now: () => NOW });
    const error = await rejectionOf(listWith(lister, "2026-10-20"));
    expect(error instanceof Error ? error.message : "").toContain(
      "verification pass",
    );
  });

  test("an unchanged one settles after its verification pass", async () => {
    const rows = dayOf(60);
    const calls = stubSearch(serve(rows));
    const lister = createBrTstSliceLister({ now: () => NOW });
    const listed = await listWith(lister, "2026-10-20");
    expect(Result.isOk(listed) && listed.value.keyed.size).toBe(60);
    // The count, then each page twice.
    expect(calls.filter(({ size }) => size > 0)).toHaveLength(4);
  });

  test("a day past the court's indexing window is listed once", async () => {
    const calls = stubSearch(serve(dayOf(60)));
    const lister = createBrTstSliceLister({ now: () => NOW });
    await listWith(lister, "2024-03-15");
    expect(calls.filter(({ size }) => size > 0)).toHaveLength(2);
    expect(BR_TST_MUTABLE_DAYS).toBeGreaterThan(56);
  });
});

describe("a record with no id", () => {
  const record = (): Record<string, unknown> => {
    const [row] = dayOf(1);
    const { id: _id, ...rest } = row ?? {};
    return { ...rest, dtaAtualizacao: "2026-04-27T17:00:08-03" };
  };

  test("is keyed, counted and held as a listing-only row", async () => {
    stubSearch(() => responseOf(1, [record()]));
    const lister = createBrTstSliceLister({ now: () => NOW });
    const listed = await listWith(lister, "2024-03-15");
    const item = Result.isOk(listed)
      ? [...listed.value.keyed.values()].at(0)
      : undefined;
    expect(item?.identity).toEqual({
      type: "document",
      sourceDocumentId: brTstQuarantineId(record()),
    });
    const outcome = await brTstAdapter.reconciliation.buildDecision(
      item?.payload,
    );
    expect(outcome.type === "built" && outcome.decision.isListingOnly).toBe(
      true,
    );
  });

  test("keeps its quarantine identity across reindexing, and its id later adopts it", () => {
    const quarantined = buildBrTstDecision(record()).decision;
    const reindexed = buildBrTstDecision({
      ...record(),
      dtaAtualizacao: "2027-01-01T00:00:00-03",
      dtaOrdenacao: "2027-01-01T00:00:00-03",
    }).decision;
    expect(reindexed.sourceDocumentId).toBe(quarantined.sourceDocumentId);
    const recovered = buildBrTstDecision({
      ...record(),
      id: "f0000000000000000000000000000000",
    }).decision;
    expect(recovered.sourceDocumentId).toBe(
      "ACORDAO:f0000000000000000000000000000000",
    );
    expect(recovered.sourceDocumentIdRepairAliases).toEqual([
      quarantined.sourceDocumentId ?? "",
    ]);
  });
});

describe("the slice lister's state", () => {
  test("is dropped when a page fails", async () => {
    stubSearch(({ start, size }) =>
      start > 1
        ? new Response("", { status: 500 })
        : serve(dayOf(120))({ start, size, body: {} }),
    );
    const lister = createBrTstSliceLister({ now: () => NOW });
    expect(await rejectionOf(listWith(lister, "2024-03-15"))).toBeInstanceOf(
      AdapterFetchError,
    );
    expect(lister.held()).toBe(0);
  });

  test("is bounded when listings are abandoned after their first page", async () => {
    stubSearch(serve(dayOf(120)));
    const lister = createBrTstSliceLister({ now: () => NOW });
    for (const day of [
      "2024-03-11",
      "2024-03-12",
      "2024-03-13",
      "2024-03-14",
      "2024-03-15",
      "2024-03-18",
    ]) {
      await lister.listSlicePage({ slice: day, page: 0 });
    }
    expect(lister.held()).toBe(BR_TST_HELD_LISTINGS);
  });
});
