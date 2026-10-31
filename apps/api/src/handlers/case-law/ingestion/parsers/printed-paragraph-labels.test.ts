import { expect, test } from "bun:test";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { PROCESSED_FIELD_EVIDENCE_READERS } from "@/api/tests/helpers/processed-field-evidence";

import { parseNsDecisionHtml } from "./cz-ns";

const FIXTURES = "src/handlers/case-law/ingestion/parsers/__fixtures__/";
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);
const labels = (ast: DocumentAst) =>
  ast.blocks.flatMap((block) =>
    block.type === "paragraph" && block.number !== undefined
      ? [block.number]
      : [],
  );

test("glued regional markers retain every printed label, including the proven OCR first marker", async () => {
  const [decision] = await PROCESSED_FIELD_EVIDENCE_READERS["cz-regional"](
    `${FIXTURES}printed-labels/cz-regional-20-co-186-2026.finaldoc.json.gz`,
  );
  expect(decision).toBeDefined();
  if (decision === undefined) {
    return;
  }
  expect(labels(decision.ast)).toEqual(range(1, 20));
  const numbered = decision.ast.blocks.filter(
    (block) => block.type === "paragraph" && block.number !== undefined,
  );
  expect(numbered.at(0)?.plainText.startsWith("Napadeným rozsudkem")).toBe(
    true,
  );
  expect(numbered.at(1)?.plainText.startsWith("Soud I. stupně")).toBe(true);
});

test("a duplicated NS paragraph 13 preserves both labels and every later label", async () => {
  const printHtml = new TextDecoder().decode(
    Bun.gunzipSync(
      await Bun.file(
        `${FIXTURES}printed-labels/cz-ns-30-cdo-5117-2017.print.html.gz`,
      ).bytes(),
    ),
  );
  expect(printHtml.match(/13\./gu)?.length).toBeGreaterThanOrEqual(2);
  const { documentAst } = parseNsDecisionHtml({
    documentId: "3AB0B34FEB2EE356C12584DF001EFD28",
    webUrl:
      "https://rozhodnuti.nsoud.cz/Judikatura/judikatura_ns.nsf/WebSearch/3AB0B34FEB2EE356C12584DF001EFD28?openDocument",
    printUrl:
      "https://rozhodnuti.nsoud.cz/Judikatura/judikatura_ns.nsf/WebPrint/3AB0B34FEB2EE356C12584DF001EFD28?openDocument",
    webHtml: "",
    printHtml,
  });
  expect(labels(documentAst)).toEqual([...range(1, 13), ...range(13, 31)]);
});

test("each Constitutional Court separate opinion retains its own printed sequence", async () => {
  const [decision] = await PROCESSED_FIELD_EVIDENCE_READERS["cz-us"](
    `${FIXTURES}printed-labels/cz-us-pl-us-29-11.html.gz`,
  );
  expect(decision).toBeDefined();
  if (decision === undefined) {
    return;
  }
  expect(labels(decision.ast)).toEqual([
    ...range(1, 71),
    ...range(1, 12),
    ...range(1, 12),
    ...range(1, 26),
  ]);
  const first = decision.ast.blocks.find(
    (block) =>
      block.type === "paragraph" &&
      block.role === "dissent" &&
      block.plainText.startsWith("Vyslovuji pochybnost"),
  );
  expect(first).toMatchObject({ number: 1 });
  expect(first?.plainText.startsWith("Vyslovuji pochybnost")).toBe(true);
});

test("NSS ordered HTML lists carry decimal labels across start attributes", async () => {
  const [decision] = await PROCESSED_FIELD_EVIDENCE_READERS["cz-nss"](
    `${FIXTURES}cz-nss-57-af-17-2023.html.gz`,
  );
  expect(decision).toBeDefined();
  if (decision === undefined) {
    return;
  }
  expect(labels(decision.ast)).toEqual(range(1, 35));
});
