/**
 * Unit tests for the template fill preview plugin's entry tracking.
 * The plugin keeps a list of matched marker → value entries in sync
 * with the doc; the paged editor projects its overlay from these
 * entries (the inline decorations are derived from the same list), so
 * getting the entries right is the whole correctness story.
 */

import { describe, expect, test } from "bun:test";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";

import { schema } from "../schema";
import {
  createTemplatePreviewValuesPlugin,
  templatePreviewValuesKey,
  templatePreviewValueText,
} from "./templatePreviewValues";
import type {
  TemplatePreviewEntry,
  TemplatePreviewValues,
} from "./templatePreviewValues";

const docOf = (...paragraphs: string[]): PMNode =>
  schema.node(
    "doc",
    null,
    paragraphs.map((text) =>
      schema.node("paragraph", null, text ? [schema.text(text)] : null),
    ),
  );

const makeState = (
  doc: PMNode,
  preview: TemplatePreviewValues | null,
): EditorState => {
  const plugin = createTemplatePreviewValuesPlugin();
  const state = EditorState.create({ doc, plugins: [plugin] });
  return state.apply(state.tr.setMeta(templatePreviewValuesKey, { preview }));
};

const getEntries = (state: EditorState): readonly TemplatePreviewEntry[] =>
  templatePreviewValuesKey.getState(state)?.entries ?? [];

const sliceFromTo = (doc: PMNode, from: number, to: number): string =>
  doc.textBetween(from, to, "");

describe("templatePreviewValues: entry tracking", () => {
  test("exposes one entry per matched placeholder, spanning the marker", () => {
    const doc = docOf(
      "Tenant {{tenant.name}} signs on {{signing_date}}.",
      "Landlord {{landlord.name}} agrees.",
    );
    const state = makeState(doc, {
      values: { "tenant.name": "Pavel Novák", signing_date: "2026-06-10" },
      mode: "highlighted",
    });

    const entries = getEntries(state);
    expect(
      entries.map((e) => `${e.expr}=${templatePreviewValueText(e.value)}`),
    ).toEqual(["tenant.name=Pavel Novák", "signing_date=2026-06-10"]);
    for (const entry of entries) {
      expect(sliceFromTo(state.doc, entry.from, entry.to)).toBe(
        `{{${entry.expr}}}`,
      );
    }
  });

  test("rich values surface on entries verbatim; rich values with no text are skipped", () => {
    const doc = docOf("Company {{company}} and {{empty}} sign.");
    const richValue = {
      runs: [{ text: "Acme", bold: true }, { text: ", Poznań" }],
    };
    const state = makeState(doc, {
      values: { company: richValue, empty: { runs: [{ text: "" }] } },
      mode: "plain",
    });

    const entries = getEntries(state);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.expr).toBe("company");
    expect(entries[0]!.value).toEqual(richValue);
  });

  test("skips empty values, unmatched fields, and non-placeholder markers", () => {
    const doc = docOf(
      "Field {{tenant.name}} and clause {{@clause:Indemnity}}.",
      "{{#if premium}}",
      "Premium terms for {{tenant.name}}.",
      "{{/if}}",
    );
    const state = makeState(doc, {
      values: {
        "tenant.name": "",
        "landlord.name": "Unused",
        "@clause:Indemnity": "Not a field",
        premium: "true",
      },
      mode: "plain",
    });

    expect(getEntries(state)).toEqual([]);
  });

  test("builds an inline (hide) + widget (value) decoration pair per entry", () => {
    const doc = docOf("Tenant {{tenant.name}} signs.");
    const state = makeState(doc, {
      values: { "tenant.name": "Pavel Novák" },
      mode: "plain",
    });

    const decorationSet =
      templatePreviewValuesKey.getState(state)?.decorationSet;
    const decorations = decorationSet?.find() ?? [];
    expect(decorations).toHaveLength(2);
  });

  test("recomputes entry positions when the doc is edited before a marker", () => {
    const doc = docOf("Tenant {{tenant.name}} signs.");
    let state = makeState(doc, {
      values: { "tenant.name": "Pavel Novák" },
      mode: "plain",
    });

    state = state.apply(state.tr.insertText("Dear ", 1));

    const entries = getEntries(state);
    expect(entries).toHaveLength(1);
    expect(sliceFromTo(state.doc, entries[0]!.from, entries[0]!.to)).toBe(
      "{{tenant.name}}",
    );
  });

  test("drops entries whose marker is broken by the edit", () => {
    const doc = docOf("Tenant {{tenant.name}} signs.");
    let state = makeState(doc, {
      values: { "tenant.name": "Pavel Novák" },
      mode: "plain",
    });
    expect(getEntries(state)).toHaveLength(1);

    // Break the closing braces; the marker no longer parses.
    const entry = getEntries(state)[0]!;
    state = state.apply(state.tr.delete(entry.to - 1, entry.to));

    expect(getEntries(state)).toEqual([]);
  });

  test("clearing the preview empties entries and decorations", () => {
    const doc = docOf("Tenant {{tenant.name}} signs.");
    let state = makeState(doc, {
      values: { "tenant.name": "Pavel Novák" },
      mode: "highlighted",
    });
    expect(getEntries(state)).toHaveLength(1);

    state = state.apply(
      state.tr.setMeta(templatePreviewValuesKey, { preview: null }),
    );

    expect(getEntries(state)).toEqual([]);
    expect(
      templatePreviewValuesKey.getState(state)?.decorationSet.find() ?? [],
    ).toHaveLength(0);
  });
});
