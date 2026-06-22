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
