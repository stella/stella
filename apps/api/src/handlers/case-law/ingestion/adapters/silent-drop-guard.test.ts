import { panic } from "better-result";
import { afterEach, expect, test } from "bun:test";
import * as cheerio from "cheerio";
import { isTag } from "domhandler";

import {
  decodeSourceRawEnvelope,
  encodeSourceRawEnvelope,
  type StoredRawReparseInput,
} from "@/api/handlers/case-law/ingestion/adapter";
import { listAdapters } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import baseline from "@/api/handlers/case-law/ingestion/adapters/silent-drop-guard-baseline.json";
import { isRecord } from "@/api/lib/type-guards";
import {
  czNsFixture,
  czNssFixture,
  czRegionalFixture,
  czUsFixture,
  plCourtsFixture,
  plKioFixture,
  plKisFixture,
  plNcourtFixture,
  plNsaFixture,
  plTkFixture,
  plUodoFixture,
  plUokikFixture,
  euEcjFixture,
  skUsFixture,
  type EnrolledAdapterFixture,
} from "@/api/tests/helpers/case-law-enrolled-fixtures";

type SupportedDriver = {
  driver: "html" | "xml" | "json-text";
  fixture: () => EnrolledAdapterFixture;
  part: string;
  file?: string;
  text?: string;
};
type Driver = SupportedDriver | { driver: "unsupported"; reason: string };
const DRIVERS = {
  "cz-ns": {
    driver: "html",
    fixture: czNsFixture,
    part: "print",
    file: "cz-ns-page.json.gz",
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
    driver: "html",
    fixture: czUsFixture,
    part: "document",
    file: "cz-us-page.json.gz",
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
  },
  "pl-tk": {
    driver: "html",
    fixture: plTkFixture,
    part: "case-page",
    file: "../parsers/__fixtures__/pl-tk-case-sk-14-11.html.gz",
  },
  "pl-nsa": {
    driver: "json-text",
    fixture: plNsaFixture,
    part: "row",
    file: "pl-nsa-rows.json",
  },
  "pl-ncourt": {
    driver: "xml",
    fixture: plNcourtFixture,
    part: "document",
    file: "pl-ncourt-content-155020000001003_II_Ca_000236_2018_Uz_2018-03-22_001.xml.gz",
  },
  "eu-ecj": {
    driver: "html",
    fixture: euEcjFixture,
    part: "document",
    file: "eu-ecj-fulltext-en.html",
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
    driver: "html",
    fixture: plUokikFixture,
    part: "detail",
    file: "pl-uokik-detail-2520d55b0f17a317c1257ec6007b9773.html",
  },
} as const satisfies Record<string, Driver>;
const drivers = new Map<string, Driver>(Object.entries(DRIVERS));
const replayAdapters = listAdapters().filter(
  ({ reparseStoredRaw }) => reparseStoredRaw !== undefined,
);
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

type Slot = { path: readonly (string | number)[]; text: string };
const slotsOf = (
  value: unknown,
  driver: SupportedDriver["driver"],
  path: readonly (string | number)[] = [],
): Slot[] => {
  if (typeof value === "string") {
    const key = path.at(-1);
    return (
      driver === "json-text"
        ? key === "text" || key === "full_text"
        : /<[A-Za-z][^>]*>/u.test(value)
    )
      ? [{ path, text: value }]
      : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      slotsOf(item, driver, [...path, index]),
    );
  }
  return isRecord(value)
    ? Object.entries(value).flatMap(([key, item]) =>
        slotsOf(item, driver, [...path, key]),
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
    return value.map((item, index) =>
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
const czUsRecordedInput = async (
  base: StoredRawReparseInput,
): Promise<StoredRawReparseInput> => {
  const bytes = await Bun.file(
    new URL("__fixtures__/cz-us-page.json.gz", import.meta.url),
  ).bytes();
  const recorded = payloadOf(new TextDecoder().decode(Bun.gunzipSync(bytes)));
  const page = isRecord(recorded) ? recorded["page"] : undefined;
  const rows = isRecord(page) ? page["decisions"] : undefined;
  const row = Array.isArray(rows) ? rows.at(0) : undefined;
  if (!isRecord(row)) {
    return panic("CZ-US recording has no decision row");
  }
  const legacy =
    typeof row["sourceRaw"] === "string"
      ? payloadOf(row["sourceRaw"])
      : undefined;
  if (!isRecord(legacy) || typeof legacy["textHtml"] !== "string") {
    return panic("CZ-US recording has no legacy textHtml");
  }
  const metadata = isRecord(row["metadata"]) ? row["metadata"] : {};
  const optionalString = (key: string): string | null =>
    typeof row[key] === "string" ? row[key] : null;
  const requiredString = (key: string): string => {
    const value = row[key];
    return typeof value === "string"
      ? value
      : panic(`CZ-US recording is missing ${key}`);
  };
  const raw = encodeSourceRawEnvelope({
    ...(typeof legacy["listingHtml"] === "string"
      ? { listing: legacy["listingHtml"] }
      : {}),
    document: legacy["textHtml"],
    ...(typeof legacy["abstractHtml"] === "string"
      ? { abstract: legacy["abstractHtml"] }
      : {}),
  });
  return {
    ...base,
    raw: new TextEncoder().encode(raw),
    contentType: optionalString("sourceRawContentType"),
    caseNumber: requiredString("caseNumber"),
    sourceDocumentId: optionalString("sourceDocumentId"),
    language: requiredString("language"),
    court: requiredString("court"),
    ecli: optionalString("ecli"),
    decisionDate: optionalString("decisionDate"),
    decisionType: optionalString("decisionType"),
    sourceUrl: optionalString("sourceUrl"),
    documentUrl: optionalString("documentUrl"),
    metadata,
  };
};
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
  if (file === "cz-us-page.json.gz") {
    const page = isRecord(recorded) ? recorded["page"] : undefined;
    const rows = isRecord(page) ? page["decisions"] : undefined;
    const first = Array.isArray(rows) ? rows.at(0) : undefined;
    const raw = isRecord(first) ? first["sourceRaw"] : undefined;
    if (typeof raw !== "string") {
      return panic("Recording has no raw");
    }
    const envelope = decodeSourceRawEnvelope(raw);
    if (envelope !== null) {
      return (
        envelope[driver.part] ?? panic("Recording has no decision document")
      );
    }
    const legacy = payloadOf(raw);
    const textHtml = isRecord(legacy) ? legacy["textHtml"] : undefined;
    return typeof textHtml === "string"
      ? textHtml
      : panic("Legacy recording has no decision document");
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
  const reported = JSON.stringify(unmapped) ?? "";
  return tokens.filter(
    (token) => !fulltext.includes(token) && !reported.includes(token),
  );
};
const expected = new Map<string, readonly string[]>(
  Object.entries(baseline.misses),
);
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
      expect(expected.has(adapter.key)).toBe(false);
      return;
    }
    const replay = adapter.reparseStoredRaw ?? panic("Replay disappeared");
    const fixtureInput = inputOf(await driver.fixture().buildDecision());
    const input =
      adapter.key === "cz-us"
        ? await czUsRecordedInput(fixtureInput)
        : fixtureInput;
    const parts =
      decodeSourceRawEnvelope(new TextDecoder().decode(input.raw)) ??
      panic("Fixture has no envelope");
    const payload = await fixturePayload(
      driver,
      parts[driver.part] ?? panic(`Fixture has no ${driver.part}`),
    );
    const slots = slotsOf(payload, driver.driver);
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
      const $ = cheerio.load(slot.text, { xml: driver.driver === "xml" });
      const containers =
        driver.driver === "json-text"
          ? ["text"]
          : [
              ...new Set(
                $("*")
                  .toArray()
                  .flatMap((node) =>
                    isTag(node) && node.children.length > 0 ? [node.name] : [],
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
          const dom = cheerio.load(slot.text, { xml: driver.driver === "xml" });
          const target = dom("*")
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
          misses.push(`${slotIndex}:${kind}:${token.split("_").at(-1)}`);
        }
      }
    }
    const observed = misses.toSorted();
    expect(
      observed,
      "New misses fail; passing baseline entries must be removed",
    ).toEqual([...(expected.get(adapter.key) ?? [])]);
  }, 60_000);
}
test("a removed adapter cannot leave a stale suppression", () => {
  for (const key of expected.keys()) {
    expect(drivers.has(key)).toBe(true);
  }
});
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
