import { Result } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";
import JSZip from "jszip";
import * as slimdom from "slimdom";

import { API_VALIDATION_ERROR_CODE } from "@stll/api-contract";
import { assertProperty } from "@stll/property-testing";
import { resolvePath } from "@stll/template-conditions";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { testDocxFile } from "@/api/tests/helpers/scanned-file";

import {
  createDirectiveProcessingContext,
  processBlockDirectives,
} from "./block-directives";
import { locateFieldMarkers } from "./discover-template";
import { processInlineConditions } from "./inline-conditions";
import { paragraphOwnText, paragraphText, W_NS } from "./ooxml";
import { fillTemplate, renderedTemplateMarkers } from "./patch-template";
import {
  collectRenderedFieldTokens,
  createFieldMarkerTable,
  scopeInlineFieldTokens,
  swapFieldMarkersForTokens,
} from "./rendered-field-markers";
import type { RenderedFieldOccurrence } from "./rendered-field-markers";
import { paragraphSpanText } from "./rich-patch";
import type { TemplateData } from "./types";

const renderedInspection = (text: string, values: TemplateData) => {
  const doc = slimdom.parseXmlDocument(
    `<w:document xmlns:w="${W_NS}"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  );
  const body = doc.getElementsByTagNameNS(W_NS, "body").at(0);
  if (body === undefined) {
    throw new TypeError("Expected the document body");
  }
  const table = createFieldMarkerTable([text]);
  const context = createDirectiveProcessingContext();
  context.scopeInlineText = (options) => scopeInlineFieldTokens(table, options);
  expect(
    swapFieldMarkersForTokens(
      locateFieldMarkers(body).fieldMarkers,
      table,
    ).isOk(),
  ).toBe(true);
  expect(
    processBlockDirectives(body, values, { processingContext: context }).errors,
  ).toEqual([]);
  expect(
    processInlineConditions(body, values, [], { processingContext: context }),
  ).toEqual([]);
  const occurrences: RenderedFieldOccurrence[] = [];
  collectRenderedFieldTokens(
    body,
    context.inlineDataByParagraph,
    table,
    occurrences,
  );
  return {
    text: [...body.getElementsByTagNameNS(W_NS, "p")]
      .map(paragraphSpanText)
      .join(""),
    fields: occurrences.map(({ path, expr, scope }) => ({
      path,
      value: resolvePath(expr, scope ?? values),
    })),
  };
};

const renderedFields = (text: string, values: TemplateData) =>
  renderedInspection(text, values).fields;

const renderedValues = (text: string, values: TemplateData) =>
  renderedFields(text, values).map(({ value }) => value);

test("inline item fields contribute only the markers their own branch renders", () => {
  const text =
    "Lead {% for p in persons %}{% if p.vip %}{{ p.name | required }}{% endif %}{% endfor %}";
  expect(
    renderedValues(text, {
      persons: [{ vip: true, name: "Ann" }, { vip: false }, { vip: true }],
    }),
  ).toEqual(["Ann", undefined]);
  expect(renderedValues(text, { persons: [{ vip: false }] })).toEqual([]);
  expect(renderedValues(text, { persons: [] })).toEqual([]);
});

test("nested inline copies retain the outer item and bind each inner item", () => {
  const text =
    "Lead {% for p in persons %}{% for c in p.children %}{% if c.selected %}{{ p.name | required }}:{{ c.name | required }}{% endif %}{% endfor %}{% endfor %}";
  expect(
    renderedValues(text, {
      persons: [
        {
          name: "Ann",
          children: [{ selected: true, name: "A" }, { selected: false }],
        },
        { name: "Bob", children: [{ selected: true, name: "B" }] },
      ],
    }),
  ).toEqual(["Ann", "A", "Bob", "B"]);
});

test("sibling loops can reuse an alias without losing either field occurrence", () => {
  const text =
    "Lead {% for p in persons %}{{ p.name | required }}{% endfor %}; {% for p in buyers %}{{ p.name | required }}{% endfor %}";
  expect(
    renderedFields(text, { persons: [{ name: "Ann" }], buyers: [{}] }),
  ).toEqual([
    { path: "persons.name", value: "Ann" },
    { path: "buyers.name", value: undefined },
  ]);
});

test("authored private-use text remains literal beside field markers", () => {
  const authored = "999 0 :0 :1";
  const result = renderedInspection(`${authored} {{ name | required }}`, {
    name: "Ann",
  });
  expect(result.text).toContain(authored);
  expect(result.fields).toEqual([{ path: "name", value: "Ann" }]);
});

for (const part of ["document", "header1", "footer1"]) {
  for (const inTable of [false, true]) {
    for (const standalone of [false, true]) {
      test(`each paragraph owns its text-box markers in ${part}, table=${String(inTable)}, standalone=${String(standalone)}`, async () => {
        const inner =
          "<w:p><w:r><w:t>{{ na</w:t></w:r><w:r><w:t>me | required }}</w:t></w:r></w:p>";
        const nested = inTable
          ? `<w:tbl><w:tr><w:tc>${inner}</w:tc></w:tr></w:tbl>`
          : inner;
        const paragraph = `<w:p><w:r><w:t>${standalone ? "{{ outer }}" : "Outer {{ outer }} "}</w:t></w:r><w:r><w:pict><w:txbxContent>${nested}</w:txbxContent></w:pict></w:r><w:r><w:t>${standalone ? "" : " tail"}</w:t></w:r></w:p>`;
        const wrap = (content: string) =>
          part === "document"
            ? `<w:document xmlns:w="${W_NS}"><w:body>${content}</w:body></w:document>`
            : `<w:${part === "header1" ? "hdr" : "ftr"} xmlns:w="${W_NS}">${content}</w:${part === "header1" ? "hdr" : "ftr"}>`;
        const zip = new JSZip();
        zip.file(
          "word/document.xml",
          `<w:document xmlns:w="${W_NS}"><w:body/></w:document>`,
        );
        zip.file(`word/${part}.xml`, wrap(paragraph));
        const file = testDocxFile(
          await zip.generateAsync({ type: "uint8array" }),
        );
        const markers = await renderedTemplateMarkers(
          file,
          { outer: "A", name: "Ann" },
          [],
        );
        if (Result.isError(markers)) {
          throw markers.error;
        }
        expect(markers.value.fields.map(({ path }) => path)).toEqual([
          "outer",
          "name",
        ]);
        const filled = await fillTemplate(file, { outer: "A", name: "Ann" });
        expect(filled.structureErrors).toEqual([]);
        expect(filled.unmatchedPlaceholders).toEqual([]);
        const output = await JSZip.loadAsync(filled.file.bytes);
        const xml = await output.file(`word/${part}.xml`)?.async("string");
        expect(xml).toBeDefined();
        const doc = slimdom.parseXmlDocument(xml ?? "");
        const text = [...doc.getElementsByTagNameNS(W_NS, "t")]
          .map((node) => node.textContent)
          .join("");
        expect(text).toBe(standalone ? "AAnn" : "Outer A Ann tail");
        expect(doc.getElementsByTagNameNS(W_NS, "txbxContent")).toHaveLength(1);
      });
    }
  }
}

test("inconsistent marker counts produce a typed template refusal", () => {
  const doc = slimdom.parseXmlDocument(
    `<w:body xmlns:w="${W_NS}"><w:p><w:r><w:t>{{ name }}</w:t></w:r></w:p></w:body>`,
  );
  const paragraph = doc.getElementsByTagNameNS(W_NS, "p").at(0);
  if (paragraph === undefined) {
    throw new TypeError("Expected a paragraph");
  }
  const markers = new Map([[paragraph, []]]);
  const result = swapFieldMarkersForTokens(markers, createFieldMarkerTable([]));
  expect(Result.isError(result)).toBe(true);
  if (Result.isOk(result)) {
    throw new TypeError("Expected a typed marker refusal");
  }
  expect(result.error).toBeInstanceOf(HandlerError);
  expect(result.error.status).toBe(422);
  expect(result.error.code).toBe(API_VALIDATION_ERROR_CODE);
  expect(result.error.retryable).toBe(false);
});

test("paragraph marker ownership is independent of text-box nesting depth", () => {
  assertProperty(
    "paragraph marker ownership is independent of text-box nesting depth",
    fc.property(fc.integer({ min: 1, max: 6 }), (depth) => {
      let xml = "";
      for (let index = depth; index >= 0; index--) {
        xml = `<w:p><w:r><w:t>{{ field_${String(index)} }}</w:t></w:r>${xml === "" ? "" : `<w:r><w:pict><w:txbxContent>${xml}</w:txbxContent></w:pict></w:r>`}</w:p>`;
      }
      const doc = slimdom.parseXmlDocument(
        `<w:body xmlns:w="${W_NS}">${xml}</w:body>`,
      );
      const root = doc.documentElement;
      if (root === null) {
        throw new TypeError("Expected a document root");
      }
      const outer = root.getElementsByTagNameNS(W_NS, "p").at(0);
      if (outer === undefined) {
        throw new TypeError("Expected an outer paragraph");
      }
      expect(paragraphOwnText(outer)).toBe("{{ field_0 }}");
      expect(paragraphSpanText(outer)).toBe(paragraphOwnText(outer));
      expect(paragraphText(outer)).toContain(`{{ field_${String(depth)} }}`);
      const table = createFieldMarkerTable([paragraphText(outer)]);
      expect(
        swapFieldMarkersForTokens(
          locateFieldMarkers(root).fieldMarkers,
          table,
        ).isOk(),
      ).toBe(true);
      const occurrences: RenderedFieldOccurrence[] = [];
      collectRenderedFieldTokens(root, new Map(), table, occurrences);
      expect(occurrences.map(({ path }) => path)).toEqual(
        Array.from(
          { length: depth + 1 },
          (_, index) => `field_${String(index)}`,
        ),
      );
      expect(table.markers.size).toBe(depth + 1);
    }),
  );
});

test("authored text outside a run produces a typed template refusal", async () => {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<w:document xmlns:w="${W_NS}"><w:body><w:p><w:t>{{ name }}</w:t></w:p></w:body></w:document>`,
  );
  const file = testDocxFile(await zip.generateAsync({ type: "uint8array" }));
  const result = await renderedTemplateMarkers(file, { name: "Ann" }, []);
  expect(Result.isError(result)).toBe(true);
  if (Result.isOk(result)) {
    throw new TypeError("Expected a typed marker refusal");
  }
  expect(result.error).toBeInstanceOf(HandlerError);
  expect(result.error.status).toBe(422);
  expect(result.error.code).toBe(API_VALIDATION_ERROR_CODE);
  expect(result.error.retryable).toBe(false);
});
