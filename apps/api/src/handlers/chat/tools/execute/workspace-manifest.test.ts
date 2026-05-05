import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { readonlyOrgFunctionContracts } from "@/api/handlers/chat/tools/execute/org-manifest";
import {
  buildReadonlyFunctionTypeDeclarations,
  createReadonlyFunctionContract,
} from "@/api/handlers/chat/tools/execute/readonly-manifest";
import {
  buildReadonlyWorkspaceFunctionManifest,
  listMatterEntitiesContract,
  readonlyWorkspaceFunctionContracts,
} from "@/api/handlers/chat/tools/execute/workspace-manifest";

describe("workspace manifest helpers", () => {
  test("builds the readonly workspace manifest from the contract list", () => {
    const manifest = buildReadonlyWorkspaceFunctionManifest();

    expect(Result.isOk(manifest)).toBe(true);
    if (Result.isOk(manifest)) {
      expect(manifest.value.map((entry) => entry.name)).toEqual([
        "listMatterProperties",
        "getMatterProperties",
        "listMatterEntities",
        "getMatterEntities",
        "getMatterEntityContents",
      ]);
    }
  });

  test("returns one manifest entry for a named readonly function", () => {
    const entry = buildReadonlyWorkspaceFunctionManifest().map((manifest) =>
      manifest.find(
        (manifestEntry) => manifestEntry.name === "getMatterEntityContents",
      ),
    );

    expect(Result.isOk(entry)).toBe(true);
    if (Result.isOk(entry)) {
      expect(entry.value).toBeDefined();
    }
    if (Result.isOk(entry) && entry.value) {
      expect(entry.value.name).toBe("getMatterEntityContents");
      expect(entry.value.description).toContain("Get extracted text content");
      expect(entry.value.inputSchema.type).toBe("object");
      expect(entry.value.outputSchema.type).toBe("object");
      expect(entry.value.outputSchema.properties).toHaveProperty("items");
    }
  });

  test("documents entity links in entity lookup descriptions", () => {
    const manifest = buildReadonlyWorkspaceFunctionManifest();

    expect(Result.isOk(manifest)).toBe(true);
    if (!Result.isOk(manifest)) {
      return;
    }

    const entityEntries = manifest.value.filter(
      (entry) =>
        entry.name === "listMatterEntities" ||
        entry.name === "getMatterEntities",
    );

    expect(entityEntries).toHaveLength(2);
    for (const entry of entityEntries) {
      expect(entry.description).toContain("refs");
      expect(entry.description).toContain("#stella-entity-ref=ent_1");
    }
  });

  test("renders list pagination and requires refs for detail reads", () => {
    const declarations = buildReadonlyFunctionTypeDeclarations([
      ...readonlyOrgFunctionContracts,
      ...readonlyWorkspaceFunctionContracts,
    ]);

    expect(Result.isOk(declarations)).toBe(true);
    if (Result.isOk(declarations)) {
      expect(declarations.value).toContain("listMatters(input: {");
      expect(declarations.value).toContain("matterRefs: string[]");
      expect(declarations.value).toContain("limit?: number");
      expect(declarations.value).toContain("offset?: number");
      expect(declarations.value).toContain("getMatterEntities(input: {");
      expect(declarations.value).toContain("entityRefs: string[]");
      expect(declarations.value).toContain("Promise<{");
      expect(declarations.value).toContain("items: Array<{");
    }
  });

  test("rejects bare array outputs at compile time", () => {
    createReadonlyFunctionContract({
      description: "Invalid contract used only to enforce the type boundary.",
      input: v.strictObject({}),
      name: "invalidReadonlyArrayOutput",
      // @ts-expect-error readonly Stella AI functions must return { items } or
      // { items, hasMore, nextOffset }, never a bare record array.
      output: v.array(v.string()),
    });
  });

  test("accepts UUID file ids in entity field output", () => {
    const output = {
      hasMore: false,
      items: [
        {
          entityRef: "ent_1",
          fields: [
            {
              content: {
                encrypted: false,
                fileName: "Internal_Audit_Report.docx",
                id: "141d8c88-2fa5-5127-8e37-3ea75f52f890",
                mimeType:
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                pdfDerivative: { status: "not-required" },
                pdfFileId: null,
                sha256Hex:
                  "7079424dfa5247d9f4745e86a487dc9602f78b5944d640e589927fea6b4b4eda",
                sizeBytes: 3978,
                type: "file",
                version: 1,
              },
              propertyRef: "prop_1",
            },
          ],
          kind: "document",
          matterRef: "mat_1",
          mention: "[Internal_Audit_Report.docx](#stella-entity-ref=ent_1)",
          name: "Internal_Audit_Report.docx",
          parentRef: null,
        },
      ],
      nextOffset: null,
    };

    const result = v.safeParse(listMatterEntitiesContract.output, output);

    expect(result.success).toBe(true);
  });
});
