import { panic } from "better-result";
import { expect, test } from "bun:test";

import { hasUsableAst } from "@stll/legal-ast/document-ast";

import { buildBrTstDecision } from "@/api/handlers/case-law/ingestion/adapters/br-tst";
import { sourceRetentionForAdapter } from "@/api/handlers/case-law/ingestion/retention/retention-sources";
import { brTstRetention } from "@/api/handlers/case-law/ingestion/retention/sources/br-tst";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";
import { encodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";
import {
  BR_TST_RECORDINGS,
  brTstRecordedRecords,
} from "@/api/tests/helpers/case-law-enrolled-fixtures";

const project = async (sourceRaw: string) =>
  await brTstRetention.project(sourceRaw);

test("every recorded record type is measured against its own stored record", async () => {
  expect(sourceRetentionForAdapter(ADAPTER_KEYS.BR_TST).policy).toBe(
    brTstRetention,
  );
  let measured = 0;
  for (const name of BR_TST_RECORDINGS) {
    for (const record of await brTstRecordedRecords(name)) {
      const { decision } = buildBrTstDecision(record);
      if (
        !hasUsableAst(decision.documentAst) ||
        decision.sourceRaw === undefined
      ) {
        continue;
      }
      const projection = await project(decision.sourceRaw);
      if (projection.type !== "source") {
        panic(`${name}: a parsed record must have publisher text`);
      }
      expect({
        name,
        ok: validateAst(projection.source, decision.documentAst.blocks).ok,
      }).toEqual({ name, ok: true });
      measured += 1;
    }
  }
  expect(measured).toBeGreaterThan(0);
});

test("a record that loses its body fails the check", async () => {
  const [record] = await brTstRecordedRecords("br-tst-acordao-2024.json");
  const { decision } = buildBrTstDecision(
    record ?? panic("the acórdão recording lost its record"),
  );
  if (!hasUsableAst(decision.documentAst) || decision.sourceRaw === undefined) {
    panic("the acórdão must have parsed blocks and stored raw");
  }
  const projection = await project(decision.sourceRaw);
  if (projection.type !== "source") {
    panic("the acórdão must have publisher text");
  }
  expect(
    validateAst(projection.source, decision.documentAst.blocks.slice(0, 1)).ok,
  ).toBe(false);
});

test("each record type reads its own text fields", async () => {
  const listing = (record: Record<string, unknown>) =>
    encodeSourceRawEnvelope({ listing: JSON.stringify(record) });
  expect(
    await project(
      listing({
        tipo: { codigoTipoJurisprudencia: "DESPACHO" },
        txtConteudoDecisao: "<![CDATA[<p>Primeiro</p><p>Segundo</p>]]>",
      }),
    ),
  ).toEqual({
    type: "source",
    source: { type: "paragraphs", paragraphs: ["Primeiro", "Segundo"] },
  });
  expect(
    await project(
      listing({
        tipo: { codigoTipoJurisprudencia: "DESPACHO" },
        txtConteudoDecisao: "Primeiro\r\n\r\nSegundo",
      }),
    ),
  ).toEqual({
    type: "source",
    source: { type: "paragraphs", paragraphs: ["Primeiro", "Segundo"] },
  });
  expect(
    await project(
      listing({
        tipo: { codigoTipoJurisprudencia: "SUM" },
        titulo: "SUM-1",
        tese: "I - item<br>\n<s>II - cancelado</s>",
        observacao: "removido no backend",
      }),
    ),
  ).toEqual({
    type: "source",
    source: {
      type: "paragraphs",
      paragraphs: ["SUM-1", "I - item", "II - cancelado"],
    },
  });
});

test("a record without its text, or an unreadable raw, cannot pass unchecked", async () => {
  expect(
    await project(
      encodeSourceRawEnvelope({
        listing: JSON.stringify({
          tipo: { codigoTipoJurisprudencia: "ACORDAO" },
          inteiroTeorHtml: "removido no backend",
        }),
      }),
    ),
  ).toEqual({ type: "no-text", reason: "not-published" });
  for (const raw of [
    "not an envelope",
    encodeSourceRawEnvelope({ document: "{}" }),
    encodeSourceRawEnvelope({ listing: "not json" }),
  ]) {
    expect((await project(raw)).type).toBe("unreadable");
  }
});
