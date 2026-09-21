import { describe, expect, test } from "bun:test";

import { FILE_COMPARISON_TRANSPORT } from "@stll/api-contract";

import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  handleOpenFileComparisonTool,
  OPEN_FILE_COMPARISON_TOOL_DEFINITION,
} from "@/api/mcp/file-comparison-picker-tool";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const contextFor = (memberRole: string): McpRequestContext =>
  asTestRaw<McpRequestContext>({
    accessibleWorkspaceIds: [],
    accessibleWorkspaceIdSet: new Set<string>(),
    accessibleWorkspaceStatusById: new Map(),
    accessibleWorkspaces: [],
    grantedScopes: ["stella:documents_write"],
    memberRole,
    organizationId: toSafeId<"organization">("org_1"),
    userId: toSafeId<"user">("user_1"),
  });

type PickerResult = Awaited<ReturnType<typeof handleOpenFileComparisonTool>>;

const errorOf = (result: PickerResult) => {
  if (
    "egress" in result ||
    result.status !== "error" ||
    result.error.type !== "structured"
  ) {
    throw new Error(
      `Expected a structured error, got ${JSON.stringify(result)}`,
    );
  }
  return result.error;
};

describe("open_file_comparison", () => {
  test("declares the comparison panel as its UI, visible to model and app", () => {
    expect(OPEN_FILE_COMPARISON_TOOL_DEFINITION._meta).toEqual({
      ui: {
        resourceUri: FILE_COMPARISON_TRANSPORT.resourceUri,
        visibility: ["model", "app"],
      },
    });
  });

  test("opens the panel for a role that may update documents", async () => {
    const result = await handleOpenFileComparisonTool({
      args: {},
      context: contextFor("owner"),
    });

    if ("egress" in result || result.status !== "success") {
      throw new Error(`Expected success, got ${JSON.stringify(result)}`);
    }
    expect(result.data).toEqual({});
    expect(result.mcp?.primaryText).toContain(
      FILE_COMPARISON_TRANSPORT.compareToolName,
    );
  });

  test("refuses a role that cannot update documents before the panel opens", async () => {
    const error = errorOf(
      await handleOpenFileComparisonTool({
        args: {},
        context: contextFor("external"),
      }),
    );

    expect(error.code).toBe("permission_denied");
  });

  test("refuses an input the schema does not declare", async () => {
    const error = errorOf(
      await handleOpenFileComparisonTool({
        args: { entity_id: "00000000-0000-4000-8000-000000000001" },
        context: contextFor("owner"),
      }),
    );

    expect(error.code).toBe("validation_error");
  });
});
