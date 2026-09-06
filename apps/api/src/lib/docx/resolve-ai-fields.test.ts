import { describe, expect, test } from "bun:test";

import {
  type AiFieldDraft,
  type AiFieldGenerator,
  resolveAiFields,
} from "./resolve-ai-fields";
import type { FieldMeta } from "./types";

const drafted = (value: string): AiFieldDraft => ({ type: "drafted", value });

const echoGenerator: AiFieldGenerator = async ({ prompt }) =>
  drafted(`DRAFT[${prompt}]`);

const fields: FieldMeta[] = [
  { path: "client.name" }, // plain field
  { path: "scope", aiPrompt: "Draft the scope of this power of attorney" },
];

describe("resolveAiFields", () => {
  test("drafts AI fields and leaves plain fields untouched", async () => {
    const result = await resolveAiFields({
      values: { "client.name": "ACME" },
      fields,
      generate: echoGenerator,
    });
    expect(result.values).toEqual({
      "client.name": "ACME",
      scope: "DRAFT[Draft the scope of this power of attorney]",
    });
  });

  test("a user-supplied value wins over the AI draft", async () => {
    const result = await resolveAiFields({
      values: { scope: "manually written scope" },
      fields,
      generate: echoGenerator,
    });
    expect(result.values["scope"]).toBe("manually written scope");
  });

  test("a nested user value wins for a dotted AI-field path", async () => {
    // The fill form nests dotted paths, so the user's value arrives under
    // `company`, not at the flat key `company.scope`.
    const result = await resolveAiFields({
      values: { company: { scope: "manually written scope" } },
      fields: [{ path: "company.scope", aiPrompt: "Draft the scope" }],
      generate: echoGenerator,
    });
    expect(result.values).toEqual({
      company: { scope: "manually written scope" },
    });
  });

  test("a flat dotted user value wins (fill_template tool shape)", async () => {
    // The fill_template chat tool sends flat dotted keys, not nested objects.
    const result = await resolveAiFields({
      values: { "company.scope": "manually written scope" },
      fields: [{ path: "company.scope", aiPrompt: "Draft the scope" }],
      generate: echoGenerator,
    });
    expect(result.values["company.scope"]).toBe("manually written scope");
  });

  test("does not disclose source-bound values to the AI generator", async () => {
    let seenValues: Record<string, unknown> | undefined;

    const result = await resolveAiFields({
      values: {
        "client.taxId": "TAX-ID-SECRET-12345",
        "client.name": "ACME",
      },
      fields: [
        {
          path: "client.taxId",
          source: { kind: "contact", field: "taxId" },
        },
        { path: "summary", aiPrompt: "Draft a summary" },
      ],
      generate: async ({ values }) => {
        seenValues = values;
        return drafted("safe draft");
      },
    });

    expect(seenValues).toEqual({ "client.name": "ACME" });
    expect(result.values["client.taxId"]).toBe("TAX-ID-SECRET-12345");
    expect(result.values["summary"]).toBe("safe draft");
  });

  test("leaves AI fields unfilled when no generator is supplied", async () => {
    const result = await resolveAiFields({
      values: {},
      fields,
      generate: undefined,
    });
    expect(result.values["scope"]).toBeUndefined();
  });

  test("a failed draft leaves the field unfilled and is reported", async () => {
    const result = await resolveAiFields({
      values: {},
      fields,
      generate: async () => ({
        type: "failed",
        reason: "truncated",
        message: "The model reached its output limit before finishing.",
      }),
    });

    expect("scope" in result.values).toBe(false);
    expect(result.errors).toEqual([
      {
        fieldPath: "scope",
        valuePath: "scope",
        itemIndex: null,
        reason: "truncated",
        message: "The model reached its output limit before finishing.",
      },
    ]);
  });

  test("hands the generator the field's declared max length", async () => {
    let seen: number | undefined;
    await resolveAiFields({
      values: {},
      fields: [
        {
          path: "scope",
          aiPrompt: "Draft the scope",
          validation: { maxLength: 4000 },
        },
      ],
      generate: async ({ maxLength }) => {
        seen = maxLength;
        return drafted("scope");
      },
    });

    expect(seen).toBe(4000);
  });

  test("a drafted field reports no error", async () => {
    const result = await resolveAiFields({
      values: {},
      fields,
      generate: echoGenerator,
    });

    expect(result.errors).toEqual([]);
  });

  test("injects the document text only for fields that opted in", async () => {
    const seenByPath = new Map<string, string | undefined>();
    const capturingGenerator: AiFieldGenerator = async ({
      fieldPath,
      documentText,
    }) => {
      seenByPath.set(fieldPath, documentText);
      return drafted(`DRAFT[${fieldPath}]`);
    };
    await resolveAiFields({
      values: {},
      fields: [
        { path: "reads", aiPrompt: "Draft", aiSeesDocument: true },
        { path: "blind", aiPrompt: "Draft", aiSeesDocument: false },
        { path: "absent", aiPrompt: "Draft" },
      ],
      generate: capturingGenerator,
      documentText: "THE CONTRACT BODY",
    });
    expect(seenByPath.get("reads")).toBe("THE CONTRACT BODY");
    expect(seenByPath.get("blind")).toBeUndefined();
    expect(seenByPath.get("absent")).toBeUndefined();
  });

  test("an opted-in field gets no document text when none is supplied", async () => {
    let seen: string | undefined = "sentinel";
    await resolveAiFields({
      values: {},
      fields: [{ path: "reads", aiPrompt: "Draft", aiSeesDocument: true }],
      generate: async ({ documentText }) => {
        seen = documentText;
        return drafted("DRAFT");
      },
    });
    expect(seen).toBeUndefined();
  });
});

const arrayFields: FieldMeta[] = [
  { path: "contracts.summary", aiPrompt: "Summarize this contract" },
];

describe("resolveAiFields — array-scoped (per-item) fields", () => {
  test("ignores paths with reserved object segments", async () => {
    const original = Object.hasOwn(Object.prototype, "draft");
    await resolveAiFields({
      values: { contracts: [{ name: "Alpha" }] },
      fields: [{ path: "contracts.__proto__.draft", aiPrompt: "Draft a note" }],
      generate: async () => drafted("NOTE"),
    });

    expect(Object.hasOwn(Object.prototype, "draft")).toBe(original);
  });

  test("drafts once per row and injects at the remainder path on each row", async () => {
    const seenNames: string[] = [];
    const result = await resolveAiFields({
      values: {
        contracts: [{ name: "Alpha" }, { name: "Beta" }],
      },
      fields: arrayFields,
      generate: async ({ values }) => {
        seenNames.push(String(values["name"]));
        return drafted(`SUMMARY[${String(values["name"])}]`);
      },
    });
    // One draft per row, grounded in the row object (not the whole data object).
    expect(seenNames).toHaveLength(2);
    // oxlint-disable-next-line require-cached-collator/require-cached-collator -- test-only order-independence check on fixture values, not display text
    expect([...seenNames].sort((a, b) => a.localeCompare(b))).toEqual([
      "Alpha",
      "Beta",
    ]);
    // Value written onto the row object at the remainder path; no flat key.
    expect(result.values).toEqual({
      contracts: [
        { name: "Alpha", summary: "SUMMARY[Alpha]" },
        { name: "Beta", summary: "SUMMARY[Beta]" },
      ],
    });
    expect("contracts.summary" in result.values).toBe(false);
  });

  test("does not disclose source-bound row values to the AI generator", async () => {
    const seenValues: Record<string, unknown>[] = [];
    const result = await resolveAiFields({
      values: {
        contracts: [
          {
            name: "Alpha",
            client: { taxId: "TAX-ID-SECRET-12345", name: "ACME" },
          },
        ],
      },
      fields: [
        {
          path: "contracts.client.taxId",
          source: { kind: "contact", field: "taxId" },
        },
        { path: "contracts.summary", aiPrompt: "Summarize this contract" },
      ],
      generate: async ({ values }) => {
        seenValues.push(values);
        return drafted("SAFE SUMMARY");
      },
    });

    expect(seenValues).toEqual([{ name: "Alpha", client: { name: "ACME" } }]);
    expect(result.values["contracts"]).toEqual([
      {
        name: "Alpha",
        client: { taxId: "TAX-ID-SECRET-12345", name: "ACME" },
        summary: "SAFE SUMMARY",
      },
    ]);
  });

  test("passes 1-based item index and total count per row", async () => {
    const seen: { index: number; count: number }[] = [];
    await resolveAiFields({
      values: { contracts: [{ name: "A" }, { name: "B" }, { name: "C" }] },
      fields: arrayFields,
      generate: async ({ item }) => {
        if (item !== undefined) {
          seen.push(item);
        }
        return drafted("S");
      },
    });
    expect(seen.map((i) => i.count)).toEqual([3, 3, 3]);
    expect(seen.map((i) => i.index).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  test("skips rows that already carry a non-empty value", async () => {
    let calls = 0;
    const result = await resolveAiFields({
      values: {
        contracts: [
          { name: "Alpha", summary: "hand written" },
          { name: "Beta" },
          { name: "Gamma", summary: "" }, // empty -> still drafted
        ],
      },
      fields: arrayFields,
      generate: async ({ values }) => {
        calls += 1;
        return drafted(`SUMMARY[${String(values["name"])}]`);
      },
    });
    expect(calls).toBe(2); // Beta + Gamma, not Alpha
    expect(result.values).toEqual({
      contracts: [
        { name: "Alpha", summary: "hand written" },
        { name: "Beta", summary: "SUMMARY[Beta]" },
        { name: "Gamma", summary: "SUMMARY[Gamma]" },
      ],
    });
  });

  test("top-level and array-scoped fields resolve together", async () => {
    const result = await resolveAiFields({
      values: { contracts: [{ name: "Alpha" }] },
      fields: [
        { path: "execSummary", aiPrompt: "Draft the executive summary" },
        { path: "contracts.summary", aiPrompt: "Summarize" },
      ],
      generate: async ({ fieldPath, item }) =>
        item === undefined
          ? drafted(`TOP[${fieldPath}]`)
          : drafted(`ITEM[${fieldPath}]`),
    });
    expect(result.values["execSummary"]).toBe("TOP[execSummary]");
    expect(result.values["contracts"]).toEqual([
      { name: "Alpha", summary: "ITEM[contracts.summary]" },
    ]);
  });

  test("a nested remainder writes a nested record on the row", async () => {
    const result = await resolveAiFields({
      values: { contracts: [{ name: "Alpha" }] },
      fields: [{ path: "contracts.review.note", aiPrompt: "Draft a note" }],
      generate: async () => drafted("NOTE"),
    });
    expect(result.values["contracts"]).toEqual([
      { name: "Alpha", review: { note: "NOTE" } },
    ]);
  });

  test("a double-array path is skipped (one array level in v1)", async () => {
    let calls = 0;
    const result = await resolveAiFields({
      values: {
        groups: [{ items: [{ name: "A" }, { name: "B" }] }],
      },
      // groups[].items[].summary crosses two arrays.
      fields: [{ path: "groups.items.summary", aiPrompt: "Summarize" }],
      generate: async () => {
        calls += 1;
        return drafted("S");
      },
    });
    expect(calls).toBe(0);
    expect(result.values).toEqual({
      groups: [{ items: [{ name: "A" }, { name: "B" }] }],
    });
  });

  test("one row's failure does not lose the other rows' drafts", async () => {
    const result = await resolveAiFields({
      values: {
        contracts: [{ name: "Alpha" }, { name: "Boom" }, { name: "Gamma" }],
      },
      fields: arrayFields,
      generate: async ({ values }) => {
        const name = String(values["name"]);
        if (name === "Boom") {
          throw new Error("model exploded");
        }
        return drafted(`SUMMARY[${name}]`);
      },
    });
    expect(result.values).toEqual({
      contracts: [
        { name: "Alpha", summary: "SUMMARY[Alpha]" },
        { name: "Boom" }, // failed row left unfilled
        { name: "Gamma", summary: "SUMMARY[Gamma]" },
      ],
    });
    // The failed row is named by its 1-based position, so a caller can say
    // which item of the list has no value.
    expect(result.errors).toEqual([
      {
        fieldPath: "contracts.summary",
        valuePath: "contracts[1].summary",
        itemIndex: 2,
        reason: "generation-failed",
        message:
          "AI field generation failed. Retry or provide the value yourself.",
      },
    ]);
  });

  test("a row cut at the output ceiling is reported, not written", async () => {
    const result = await resolveAiFields({
      values: { contracts: [{ name: "Alpha" }] },
      fields: arrayFields,
      generate: async () => ({
        type: "failed",
        reason: "truncated",
        message: "The model reached its output limit before finishing.",
      }),
    });

    expect(result.values).toEqual({ contracts: [{ name: "Alpha" }] });
    expect(result.errors).toEqual([
      {
        fieldPath: "contracts.summary",
        valuePath: "contracts[0].summary",
        itemIndex: 1,
        reason: "truncated",
        message: "The model reached its output limit before finishing.",
      },
    ]);
  });

  test("failed nested array drafts carry their exact value address", async () => {
    const result = await resolveAiFields({
      values: {
        client: {
          contracts: ["Not an object row", { summary: "Provided" }, {}],
        },
      },
      fields: [
        {
          path: "client.contracts.summary",
          aiPrompt: "Summarize",
        },
      ],
      generate: async () => ({
        type: "failed",
        reason: "truncated",
        message: "Draft truncated",
      }),
    });
    expect(result.errors).toEqual([
      {
        fieldPath: "client.contracts.summary",
        valuePath: "client.contracts[2].summary",
        itemIndex: 3,
        reason: "truncated",
        message: "Draft truncated",
      },
    ]);
  });

  test("runs rows with bounded concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const rows = Array.from({ length: 10 }, (_unused, i) => ({
      name: `c${String(i)}`,
    }));
    await resolveAiFields({
      values: { contracts: rows },
      fields: arrayFields,
      generate: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        await Promise.resolve();
        inFlight -= 1;
        return drafted("S");
      },
    });
    // The named pool cap is 4; concurrency must never exceed it.
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // and it does run in parallel
  });
});
