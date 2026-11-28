import { panic } from "better-result";
import { afterEach, expect, test } from "bun:test";

import {
  decodeSourceRawEnvelope,
  encodeSourceRawEnvelope,
  type StoredRawReparseInput,
} from "@stll/case-law-ingestion-core/ingestion-types";
import { isExcludedHtmlTag } from "@stll/case-law-parsers/visible-html-text";
import { load } from "@stll/html";
import { isTag } from "@stll/html/nodes";

import { listAdapters } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import { isRecord } from "@/api/lib/type-guards";
import {
  brTjdftFixture,
  brTstFixture,
  czNsFixture,
  czNsSbirkaFixture,
  czNssFixture,
  czRegionalFixture,
  type EnrolledAdapterFixture,
  euEcjFixture,
  plCourtsFixture,
  plKioFixture,
  plKisFixture,
  plNcourtFixture,
  plNsaFixture,
  plTkFixture,
  plUodoFixture,
  skUsFixture,
  ukFclFixture,
} from "@/api/tests/helpers/case-law-enrolled-fixtures";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";

const testFetchState = createTestFetch();

type SupportedDriver = {
  driver: "html" | "xml" | "json-text";
  fixture: () => EnrolledAdapterFixture;
  part: string;
  file?: string;
  text?: string;
  textRoot?: string;
  jsonKeys?: readonly string[];
};
type Driver = SupportedDriver | { driver: "unsupported"; reason: string };
const DRIVERS = {
  "cz-ns": {
    driver: "html",
    fixture: czNsFixture,
    part: "print",
    file: "cz-ns-page.json.gz",
    // The print page opens with a back button and the #box-table-a metadata
    // table (certified by the field inventory); decision text follows it.
    textRoot: "#box-table-a ~ *",
  },
  "cz-nss": {
    driver: "html",
    fixture: czNssFixture,
    part: "document",
    text: `<!doctype html>
<!-- Synthetic document fixture; no published case or personal data. -->
<html><body>
<p>ČESKÁ REPUBLIKA</p>
<p>ROZSUDEK JMÉNEM REPUBLIKY</p>
<p>Nejvyšší správní soud rozhodl ve věci kasační stížnosti proti rozhodnutí
správního orgánu. Kasační stížnost se zamítá. Soud přezkoumal napadené
rozhodnutí a dospěl k závěru, že řízení bylo vedeno v souladu se zákonem.</p>
<ul><li>První důvod rozhodnutí.</li><li>Druhý důvod rozhodnutí.</li></ul>
<table><tbody><tr><td>Rozsah přezkumu</td><td>Napadené rozhodnutí</td></tr></tbody></table>
</body></html>`,
  },
  "cz-us": {
    driver: "unsupported",
    reason:
      "Primary decision text is RTF in input#docContentHidden, which requires an RTF/byte-level driver.",
  },
  "cz-regional": {
    driver: "json-text",
    fixture: czRegionalFixture,
    part: "document",
    file: "cz-regional-finaldoc-district.json.gz",
  },
  "sk-courts": {
    driver: "unsupported",
    reason: "PDF geometry requires a text-layer driver.",
  },
  "sk-us": {
    driver: "html",
    fixture: skUsFixture,
    part: "document",
    file: "sk-us-content.json.gz",
  },
  "pl-courts": {
    driver: "html",
    fixture: plCourtsFixture,
    part: "detail",
    file: "pl-courts-detail-common.json.gz",
  },
  "pl-sn": {
    driver: "unsupported",
    reason: "PDF geometry requires a text-layer driver.",
  },
  "pl-kio": {
    driver: "html",
    fixture: plKioFixture,
    part: "document",
    file: "pl-kio-content-30308.html.gz",
    // Document <head> holds only the exported filename <title>; decision text is in <body>.
    textRoot: "body",
  },
  "pl-tk": {
    driver: "html",
    fixture: plTkFixture,
    part: "case-page",
    file: "../parsers/__fixtures__/pl-tk-case-sk-14-11.html.gz",
    // The case page is a full portal page whose metadata tabs and bench table
    // are certified by the field inventory; the fixture ruling text is #tekst_9897.
    textRoot: "#tekst_9897",
  },
  "pl-nsa": {
    driver: "json-text",
    fixture: plNsaFixture,
    part: "row",
    file: "pl-nsa-rows.json",
    // The parser builds the document from the four section columns; full_text
    // is the retention reference/fallback.
    jsonKeys: [
      "thesis",
      "sentence",
      "reasons_for_judgment",
      "dissenting_opinion",
    ],
  },
  "pl-ncourt": {
    driver: "xml",
    fixture: plNcourtFixture,
    part: "document",
    file: "pl-ncourt-content-155020000001003_II_Ca_000236_2018_Uz_2018-03-22_001.xml.gz",
    // <xPart>/<xName> is the envelope title stored in metadata.documentTitle
    // (certified by the field inventory); decision text lives in <xBlock>.
    textRoot: "xBlock",
  },
  "eu-ecj": {
    driver: "html",
    fixture: euEcjFixture,
    part: "document",
    file: "eu-ecj-fulltext-en.html",
    // Document <head> holds only CELEX <title>/meta; ecjDocumentRoot reads <body>.
    textRoot: "body",
  },
  "uk-fcl": {
    driver: "xml",
    fixture: ukFclFixture,
    textRoot: "header, judgmentBody",
    part: "document",
    file: "../parsers/__fixtures__/uk-fcl.xml",
  },
  "hu-bhgy": {
    driver: "unsupported",
    reason: "Folio DOCX and RTF runs require an AST/byte-level driver.",
  },
  "pl-kis": {
    driver: "html",
    fixture: plKisFixture,
    part: "detail",
    file: "pl-kis-detail-05-objas.json.gz",
  },
  "pl-uodo": {
    driver: "xml",
    fixture: plUodoFixture,
    part: "body-xml",
    file: "../parsers/__fixtures__/pl-uodo-dkn-5131-45-2022.xml",
  },
  "pl-uokik": {
    driver: "unsupported",
    reason:
      "Decision text is read from stored PDF objects, which require an object-level driver.",
  },
  "cz-uohs": {
    driver: "unsupported",
    reason:
      "Decision text is read from stored PDF and office document objects, which require an object-level driver.",
  },
  "br-tjdft": {
    driver: "html",
    fixture: brTjdftFixture,
    part: "detail",
  },
  "cz-isir": {
    driver: "unsupported",
    reason: "PDF geometry requires a text-layer driver.",
  },
  "cz-ns-sbirka": {
    driver: "html",
    fixture: czNsSbirkaFixture,
    part: "detail",
    // The detail page is a whole site page; the decision's text is the one
    // cell of the entry's table the page heads "Sbírkový text rozhodnutí".
    // The labelled rows are fields, certified by the field inventory.
    textRoot: "table.content-table td.fw-400",
  },
  // The listing row is JSON whose one parsed markup is the full text. The
  // record's highlight renderings repeat that text and are deliberately not
  // read (the inventory excludes them), so the probe record carries the full
  // text alone, keyed as the fixture's decision is.
  "br-tst": {
    driver: "html",
    fixture: brTstFixture,
    part: "listing",
    text: JSON.stringify({
      id: "1440689e193408199c97a145c130b652",
      tipo: { codigoTipoJurisprudencia: "ACORDAO", nome: "Acordão" },
      orgao: { numero: 0, nome: "Tribunal Superior do Trabalho", sigla: "TST" },
      numFormatado: "RR - 1000-10.2020.5.01.0001",
      dtaJulgamento: "2024-03-06",
      inteiroTeorHtml: `<html><head></head><body>
<!-- Synthetic document fixture; no published case or personal data. -->
<p class=Identificaaao><span><b>A C Ó R D Ã O</b></span></p>
<p class=Ementa><span><b>RECURSO DE REVISTA. </b></span><span><i>Conhecimento</i> e provimento.</span></p>
<p class=Voto><span><b>V O T O</b></span></p>
<p class=Corpo><span>Conheço do recurso <u>por violação</u> do artigo.</span></p>
<p class=Date><span>Brasília, 6 de março de 2024.</span></p>
</body></html>`,
    }),
  },
} as const satisfies Record<string, Driver>;
const drivers = new Map<string, Driver>(Object.entries(DRIVERS));
const replayAdapters = listAdapters().filter(
  ({ reparseStoredRaw }) => reparseStoredRaw !== undefined,
);

afterEach(() => {
  testFetchState.restore();
});

type Slot = { path: readonly (string | number)[]; text: string };
const DEFAULT_JSON_TEXT_KEYS: readonly string[] = ["text", "full_text"];
const slotsOf = (
  value: unknown,
  driver: SupportedDriver["driver"],
  jsonKeys: readonly string[] = DEFAULT_JSON_TEXT_KEYS,
  path: readonly (string | number)[] = [],
): Slot[] => {
  if (typeof value === "string") {
    const key = path.at(-1);
    return (
      driver === "json-text"
        ? typeof key === "string" && jsonKeys.includes(key)
        : /<[A-Za-z][^>]*>/u.test(value)
    )
      ? [{ path, text: value }]
      : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      slotsOf(item, driver, jsonKeys, [...path, index]),
    );
  }
  return isRecord(value)
    ? Object.entries(value).flatMap(([key, item]) =>
        slotsOf(item, driver, jsonKeys, [...path, key]),
      )
    : [];
};
const replaceSlot = (
  value: unknown,
  path: Slot["path"],
  text: string,
): unknown => {
  const [key, ...rest] = path;
  if (key === undefined) {
    return text;
  }
  if (Array.isArray(value) && typeof key === "number") {
    return value.map((item: unknown, index) =>
      index === key ? replaceSlot(item, rest, text) : item,
    );
  }
  if (isRecord(value) && typeof key === "string") {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        name === key ? replaceSlot(item, rest, text) : item,
      ]),
    );
  }
  return panic("Probe path must belong to the fixture");
};
const payloadOf = (text: string): unknown =>
  text.trimStart().startsWith("{") || text.trimStart().startsWith("[")
    ? JSON.parse(text)
    : text;
const plKisMarkupSlot = (value: unknown): Slot => {
  const detail = isRecord(value) ? value["dokument"] : undefined;
  const fields = isRecord(detail) ? detail["fields"] : undefined;
  const index = Array.isArray(fields)
    ? fields.findIndex(
        (field) => isRecord(field) && field["key"] === "TRESC_INTERESARIUSZ",
      )
    : -1;
  const field = Array.isArray(fields) ? fields.at(index) : undefined;
  const text = isRecord(field) ? field["value"] : undefined;
  if (index < 0 || typeof text !== "string") {
    return panic("PL-KIS recording has no TRESC_INTERESARIUSZ text");
  }
  return { path: ["dokument", "fields", index, "value"], text };
};
const inputOf = (
  decision: Awaited<ReturnType<EnrolledAdapterFixture["buildDecision"]>>,
): StoredRawReparseInput => ({
  raw: new TextEncoder().encode(
    decision.sourceRaw ?? panic("Fixture has no stored raw"),
  ),
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
});
const fixturePayload = async (
  driver: SupportedDriver,
  original: string,
): Promise<unknown> => {
  let payload = payloadOf(driver.text ?? original);
  if (driver.file === undefined) {
    return payload;
  }
  const file = driver.file;
  const bytes = await Bun.file(
    new URL(
      file.startsWith("../") ? file : `__fixtures__/${file}`,
      import.meta.url,
    ),
  ).bytes();
  const recorded = payloadOf(
    new TextDecoder().decode(
      file.endsWith(".gz") ? Bun.gunzipSync(bytes) : bytes,
    ),
  );
  if (file === "cz-ns-page.json.gz") {
    const page = isRecord(recorded) ? recorded["page"] : undefined;
    const rows = isRecord(page) ? page["decisions"] : undefined;
    const first = Array.isArray(rows) ? rows.at(0) : undefined;
    const raw = isRecord(first) ? first["sourceRaw"] : undefined;
    return typeof raw === "string"
      ? (decodeSourceRawEnvelope(raw)?.[driver.part] ??
          panic("Recording has no print"))
      : panic("Recording has no raw");
  }
  if (file.startsWith("pl-kis-detail-") && driver.part === "detail") {
    const source = plKisMarkupSlot(recorded);
    const target = plKisMarkupSlot(payload);
    return replaceSlot(payload, target.path, source.text);
  }
  if (file === "cz-regional-finaldoc-district.json.gz") {
    const source =
      slotsOf(recorded, driver.driver).at(0) ??
      panic("CZ-REGIONAL recording has no document text");
    const target =
      slotsOf(payload, driver.driver).at(0) ??
      panic("CZ-REGIONAL fixture has no document text");
    return replaceSlot(payload, target.path, source.text);
  }
  if (file === "sk-us-content.json.gz") {
    const encoded = isRecord(recorded) ? recorded["content"] : undefined;
    return typeof encoded === "string"
      ? Buffer.from(encoded, "base64").toString("utf-8")
      : panic("Recording has no content");
  }
  if (typeof payload === "string" || driver.driver === "json-text") {
    return file === "pl-nsa-rows.json" ? payload : recorded;
  }
  const source =
    slotsOf(recorded, driver.driver).at(0) ?? panic("Recording has no markup");
  const target =
    slotsOf(payload, driver.driver).at(0) ?? panic("Envelope has no markup");
  payload = replaceSlot(payload, target.path, source.text);
  return payload;
};
// Count rendered AST text as well as fulltext: a parser can retain a marker
// in a table cell or apparatus block without including it in its search text.
const astPlainText = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap(astPlainText);
  }
  if (!isRecord(value)) {
    return [];
  }
  const text = value["plainText"];
  return [
    ...(typeof text === "string" ? [text] : []),
    ...Object.entries(value)
      .filter(([key]) => key !== "metadata")
      .flatMap(([, child]) => astPlainText(child)),
  ];
};

const missingFrom = ({
  tokens,
  fulltext,
  unmapped,
}: {
  tokens: readonly string[];
  fulltext: string;
  unmapped: unknown;
}): string[] => {
  const reported = unmapped === undefined ? "" : JSON.stringify(unmapped);
  return tokens.filter(
    (token) => !fulltext.includes(token) && !reported.includes(token),
  );
};
test("every registered replay path has exactly one probe disposition", () => {
  expect([...drivers.keys()].toSorted()).toEqual(
    replayAdapters.map(({ key }) => key).toSorted(),
  );
  for (const driver of drivers.values()) {
    if (driver.driver === "unsupported") {
      expect(driver.reason.trim().length).toBeGreaterThan(0);
    }
  }
});
for (const adapter of replayAdapters) {
  test(`${adapter.key}: silent child drops can only shrink`, async () => {
    const driver =
      drivers.get(adapter.key) ??
      panic(`Missing probe driver for ${adapter.key}`);
    if (driver.driver === "unsupported") {
      return;
    }
    const replay = adapter.reparseStoredRaw ?? panic("Replay disappeared");
    const input = inputOf(await driver.fixture().buildDecision());
    const parts =
      decodeSourceRawEnvelope(new TextDecoder().decode(input.raw)) ??
      panic("Fixture has no envelope");
    const payload = await fixturePayload(
      driver,
      parts[driver.part] ?? panic(`Fixture has no ${driver.part}`),
    );
    const slots = slotsOf(payload, driver.driver, driver.jsonKeys);
    expect(
      slots.length,
      `${adapter.key}: fixture reaches no text`,
    ).toBeGreaterThan(0);
    const encoded = (value: unknown): Uint8Array =>
      new TextEncoder().encode(
        encodeSourceRawEnvelope({
          ...parts,
          [driver.part]:
            typeof value === "string" ? value : JSON.stringify(value),
        }),
      );
    const control = await replay({ ...input, raw: encoded(payload) });
    expect(
      control.type,
      `${adapter.key}: unmodified fixture must replay${control.type === "rejected" ? ` (${control.rejection}: ${control.detail})` : ""}`,
    ).toBe("parsed");
    const misses: string[] = [];
    for (const [slotIndex, slot] of slots.entries()) {
      const $ = load(slot.text, { xml: driver.driver === "xml" });
      const roots =
        driver.textRoot === undefined
          ? $("*")
          : $(driver.textRoot).find("*").add($(driver.textRoot));
      expect(
        roots.length,
        "The declared text surface must exist",
      ).toBeGreaterThan(0);
      const containers =
        driver.driver === "json-text"
          ? ["text"]
          : [
              ...new Set(
                roots
                  .toArray()
                  .flatMap((node) =>
                    isTag(node) &&
                    node.children.length > 0 &&
                    !(driver.driver === "html" && isExcludedHtmlTag(node.name))
                      ? [node.name]
                      : [],
                  ),
              ),
            ].toSorted();
      for (const [kindIndex, kind] of containers.entries()) {
        const tokens = ["FIRST", "LAST", "BARE"].map(
          (position) => `TOKEN_${slotIndex}_${kindIndex}_${position}`,
        );
        const first = tokens.at(0) ?? panic("First marker missing");
        const last = tokens.at(1) ?? panic("Last marker missing");
        const bare = tokens.at(2) ?? panic("Bare marker missing");
        let mutated = `${first} ${slot.text} ${last} ${bare}`;
        if (driver.driver !== "json-text") {
          const dom = load(slot.text, { xml: driver.driver === "xml" });
          const candidates =
            driver.textRoot === undefined
              ? dom("*")
              : dom(driver.textRoot).find("*").add(dom(driver.textRoot));
          const target = candidates
            .filter((_, node) => isTag(node) && node.name === kind)
            .first();
          target.prepend(`<zzprobe>${first}</zzprobe>${bare}`);
          target.append(`<zzprobe>${last}</zzprobe>`);
          mutated = dom.html();
          expect(dom.text()).toContain(bare);
        }
        const outcome = await replay({
          ...input,
          raw: encoded(replaceSlot(payload, slot.path, mutated)),
        });
        const result = outcome.type === "parsed" ? outcome.result : null;
        for (const token of missingFrom({
          tokens,
          fulltext: `${result?.fulltext ?? ""}\n${astPlainText(result?.documentAst).join("\n")}`,
          unmapped: result?.metadata["unmappedMarkup"],
        })) {
          const position =
            token.split("_").at(-1) ?? panic("Probe marker has no position");
          misses.push(`${slotIndex}:${kind}:${position}`);
        }
      }
    }
    const observed = misses.toSorted();
    expect(
      observed,
      "Child-drop probes must survive as text or be reported in unmapped.",
    ).toEqual([]);
  }, 60_000);
}
test("a marker must survive as text or be present in the unmapped report", () => {
  expect(
    missingFrom({
      tokens: ["TOKEN_A", "TOKEN_B"],
      fulltext: "TOKEN_A",
      unmapped: ["TOKEN_B"],
    }),
  ).toEqual([]);
  expect(
    missingFrom({ tokens: ["TOKEN_A"], fulltext: "", unmapped: ["zzprobe"] }),
  ).toEqual(["TOKEN_A"]);
});
test("AST text collection reaches nested table and apparatus blocks only", () => {
  expect(
    astPlainText({
      plainText: "document",
      blocks: [{ type: "table-cell", plainText: "table cell" }],
      footnotes: [{ type: "footnote", plainText: "apparatus text" }],
      metadata: { plainText: "metadata is not AST text" },
    }),
  ).toEqual(["document", "table cell", "apparatus text"]);
});
