import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { readonlyOrgFunctionContracts } from "@/api/handlers/chat/tools/execute/org-manifest";
import { buildReadonlyFunctionTypeDeclarations } from "@/api/handlers/chat/tools/execute/readonly-manifest";
import {
  buildReadonlyWorkspaceFunctionManifest,
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
      expect(entry.value.outputSchema.type).toBe("array");
    }
  });

  test("renders list pagination and requires IDs for detail reads", () => {
    const declarations = buildReadonlyFunctionTypeDeclarations([
      ...readonlyOrgFunctionContracts,
      ...readonlyWorkspaceFunctionContracts,
    ]);

    expect(Result.isOk(declarations)).toBe(true);
    if (Result.isOk(declarations)) {
      expect(declarations.value).toContain("listMatters(input: {");
      expect(declarations.value).toContain("matterIds: string[]");
      expect(declarations.value).toContain("limit?: number");
      expect(declarations.value).toContain("offset?: number");
      expect(declarations.value).toContain("getMatterEntities(input: {");
      expect(declarations.value).toContain("entityIds: string[]");
      expect(declarations.value).toContain("Promise<Array<{");
    }
  });
});
