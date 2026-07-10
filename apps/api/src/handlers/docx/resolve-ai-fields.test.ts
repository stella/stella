import { describe, expect, test } from "bun:test";

import { type AiFieldGenerator, resolveAiFields } from "./resolve-ai-fields";
import type { FieldMeta } from "./types";

const echoGenerator: AiFieldGenerator = async ({ prompt }) =>
  `DRAFT[${prompt}]`;

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
    expect(result).toEqual({
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
    expect(result["scope"]).toBe("manually written scope");
  });

  test("a nested user value wins for a dotted AI-field path", async () => {
    // The fill form nests dotted paths, so the user's value arrives under
    // `company`, not at the flat key `company.scope`.
    const result = await resolveAiFields({
      values: { company: { scope: "manually written scope" } },
      fields: [{ path: "company.scope", aiPrompt: "Draft the scope" }],
      generate: echoGenerator,
    });
    expect(result).toEqual({ company: { scope: "manually written scope" } });
  });

  test("a flat dotted user value wins (fill_template tool shape)", async () => {
    // The fill_template chat tool sends flat dotted keys, not nested objects.
    const result = await resolveAiFields({
      values: { "company.scope": "manually written scope" },
      fields: [{ path: "company.scope", aiPrompt: "Draft the scope" }],
      generate: echoGenerator,
    });
    expect(result["company.scope"]).toBe("manually written scope");
  });

  test("leaves AI fields unfilled when no generator is supplied", async () => {
    const result = await resolveAiFields({
      values: {},
      fields,
      generate: undefined,
    });
    expect(result["scope"]).toBeUndefined();
  });

  test("a generator returning undefined leaves the field unfilled", async () => {
    const result = await resolveAiFields({
      values: {},
      fields,
      generate: async () => undefined,
    });
    expect("scope" in result).toBe(false);
  });

  test("injects the document text only for fields that opted in", async () => {
    const seenByPath = new Map<string, string | undefined>();
    const capturingGenerator: AiFieldGenerator = async ({
      fieldPath,
      documentText,
    }) => {
      seenByPath.set(fieldPath, documentText);
      return `DRAFT[${fieldPath}]`;
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
        return "DRAFT";
      },
    });
    expect(seen).toBeUndefined();
  });
});

const arrayFields: FieldMeta[] = [
  { path: "contracts.summary", aiPrompt: "Summarize this contract" },
];

describe("resolveAiFields — array-scoped (per-item) fields", () => {
  test("drafts once per row and injects at the remainder path on each row", async () => {
    const seenNames: string[] = [];
    const result = await resolveAiFields({
      values: {
        contracts: [{ name: "Alpha" }, { name: "Beta" }],
      },
      fields: arrayFields,
      generate: async ({ values }) => {
        seenNames.push(String(values["name"]));
        return `SUMMARY[${String(values["name"])}]`;
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
    expect(result).toEqual({
      contracts: [
        { name: "Alpha", summary: "SUMMARY[Alpha]" },
        { name: "Beta", summary: "SUMMARY[Beta]" },
      ],
    });
    expect("contracts.summary" in result).toBe(false);
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
        return "S";
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
        return `SUMMARY[${String(values["name"])}]`;
      },
    });
    expect(calls).toBe(2); // Beta + Gamma, not Alpha
    expect(result).toEqual({
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
        item === undefined ? `TOP[${fieldPath}]` : `ITEM[${fieldPath}]`,
    });
    expect(result["execSummary"]).toBe("TOP[execSummary]");
    expect(result["contracts"]).toEqual([
      { name: "Alpha", summary: "ITEM[contracts.summary]" },
    ]);
  });

  test("a nested remainder writes a nested record on the row", async () => {
    const result = await resolveAiFields({
      values: { contracts: [{ name: "Alpha" }] },
      fields: [{ path: "contracts.review.note", aiPrompt: "Draft a note" }],
      generate: async () => "NOTE",
    });
    expect(result["contracts"]).toEqual([
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
        return "S";
      },
    });
    expect(calls).toBe(0);
    expect(result).toEqual({
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
        return `SUMMARY[${name}]`;
      },
    });
    expect(result).toEqual({
      contracts: [
        { name: "Alpha", summary: "SUMMARY[Alpha]" },
        { name: "Boom" }, // failed row left unfilled
        { name: "Gamma", summary: "SUMMARY[Gamma]" },
      ],
    });
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
        return "S";
      },
    });
    // The named pool cap is 4; concurrency must never exceed it.
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // and it does run in parallel
  });
});
