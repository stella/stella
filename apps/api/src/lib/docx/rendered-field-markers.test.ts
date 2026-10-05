import { expect, test } from "bun:test";
import * as slimdom from "slimdom";

import { resolvePath } from "@stll/template-conditions";

import {
  createDirectiveProcessingContext,
  processBlockDirectives,
} from "./block-directives";
import { locateFieldMarkers } from "./discover-template";
import { processInlineConditions } from "./inline-conditions";
import { W_NS } from "./ooxml";
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
  swapFieldMarkersForTokens(locateFieldMarkers(body).fieldMarkers, table);
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
