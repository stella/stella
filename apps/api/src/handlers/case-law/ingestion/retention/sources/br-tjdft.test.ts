import { panic } from "better-result";
import { expect, test } from "bun:test";

import { hasUsableAst } from "@stll/legal-ast/document-ast";

import {
  assembleBrTjdftDecision,
  readBrTjdftSearch,
} from "@/api/handlers/case-law/ingestion/adapters/br-tjdft";
import { sourceRetentionForAdapter } from "@/api/handlers/case-law/ingestion/retention/retention-sources";
import { brTjdftRetention } from "@/api/handlers/case-law/ingestion/retention/sources/br-tjdft";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";
import { encodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";

const FIXTURES = new URL("../../adapters/__fixtures__/", import.meta.url);

const DETAIL_RECORDINGS = [
  "br-tjdft-detail-acordao-2010.json.gz",
  "br-tjdft-detail-acordao-designado.json.gz",
  "br-tjdft-detail-acordao-pje.json.gz",
  "br-tjdft-detail-acordao-revisor.json.gz",
  "br-tjdft-detail-decisao.json.gz",
] as const;

const project = async (sourceRaw: string) =>
  await brTjdftRetention.project(sourceRaw);

/** A recorded one-record detail answer, assembled as the crawl assembles it. */
const assembled = async (name: string) => {
  const raw = new TextDecoder().decode(
    Bun.gunzipSync(await Bun.file(new URL(name, FIXTURES)).bytes()),
  );
  const record =
    readBrTjdftSearch(raw)?.rows.at(0) ?? panic(`${name}: no TJDFT record`);
  return assembleBrTjdftDecision({
    listing: record,
    detail: { record, raw },
    detailStatus: undefined,
  });
};

test("every recorded detail answer is measured against its stored record", async () => {
  expect(sourceRetentionForAdapter(ADAPTER_KEYS.BR_TJDFT).policy).toBe(
    brTjdftRetention,
  );
  for (const name of DETAIL_RECORDINGS) {
    const decision = await assembled(name);
    if (
      !hasUsableAst(decision.documentAst) ||
      decision.sourceRaw === undefined
    ) {
      panic(`${name}: the record must parse and store its raw`);
    }
    const projection = await project(decision.sourceRaw);
    if (projection.type !== "source") {
      panic(`${name}: a parsed record must have publisher text`);
    }
    expect({
      name,
      ok: validateAst(projection.source, decision.documentAst.blocks).ok,
    }).toEqual({ name, ok: true });
  }
});

test("a decision that loses its body fails the check", async () => {
  const decision = await assembled("br-tjdft-detail-acordao-pje.json.gz");
  if (!hasUsableAst(decision.documentAst) || decision.sourceRaw === undefined) {
    panic("the PJe acórdão must parse and store its raw");
  }
  const projection = await project(decision.sourceRaw);
  if (projection.type !== "source") {
    panic("the PJe acórdão must have publisher text");
  }
  expect(
    validateAst(projection.source, decision.documentAst.blocks.slice(0, 1)).ok,
  ).toBe(false);
});

test("the full text is read in the order the court publishes it", async () => {
  const detail = (record: Record<string, unknown>) =>
    encodeSourceRawEnvelope({
      listing: "{}",
      detail: JSON.stringify({ registros: [record] }),
    });
  expect(
    await project(
      detail({
        inteiroTeorHtml: "<p>Primeiro</p><p>Segundo</p>",
        inteiroTeor: "ignored",
      }),
    ),
  ).toEqual({
    type: "source",
    source: { type: "paragraphs", paragraphs: ["Primeiro", "Segundo"] },
  });
  expect(
    await project(
      detail({
        inteiroTeorHtml: "Inteiro Teor indisponível.",
        inteiroTeor: "Primeiro\r\n\r\n  Segundo",
      }),
    ),
  ).toEqual({
    type: "source",
    source: { type: "paragraphs", paragraphs: ["Primeiro", "Segundo"] },
  });
  expect(
    await project(detail({ ementa: "Ementa.", decisao: "Decisão." })),
  ).toEqual({
    type: "source",
    source: { type: "paragraphs", paragraphs: ["Ementa.", "Decisão."] },
  });
});

test("a record without text, or an unreadable raw, cannot pass unchecked", async () => {
  expect(await project(encodeSourceRawEnvelope({ listing: "{}" }))).toEqual({
    type: "no-text",
    reason: "not-published",
  });
  expect(
    await project(
      encodeSourceRawEnvelope({
        listing: "{}",
        detail: JSON.stringify({ registros: [{ inteiroTeor: " " }] }),
      }),
    ),
  ).toEqual({ type: "no-text", reason: "not-published" });
  for (const raw of [
    "not an envelope",
    encodeSourceRawEnvelope({ detail: "not json" }),
    encodeSourceRawEnvelope({ detail: JSON.stringify({ registros: [] }) }),
  ]) {
    expect((await project(raw)).type).toBe("unreadable");
  }
});
