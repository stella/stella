import { describe, expect, mock, test } from "bun:test";
import path from "node:path";

import type { Transaction } from "@/api/db/root";
import type { AuditEvent } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { announceResourceSetUpdates } from "@/api/lib/resource-set-realtime";
import {
  runToolWithRealtime,
  WRITE_TOOL_REALTIME,
} from "@/api/mcp/tool-realtime";
import type { McpToolHandler } from "@/api/mcp/tool-types";
import { bindWorkspaceRecorder, errorResult } from "@/api/mcp/tool-utils";
import type { AuthorizedMcpRequestContext } from "@/api/mcp/write-tool-authority";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const ORGANIZATION_ID = toSafeId<"organization">("org_1");
const WORKSPACE_ID = toSafeId<"workspace">("ws_1");
const OTHER_WORKSPACE_ID = toSafeId<"workspace">("ws_2");
const TX = asTestRaw<Transaction>({});
const SUCCESS = { status: "success", data: { updated: true } };

const auditEvent = (): AuditEvent =>
  asTestRaw<AuditEvent>({ action: "update", resourceType: "entity" });

const invocation = () => {
  const recordAuditEvent = mock(async () => undefined);
  const announce = mock<typeof announceResourceSetUpdates>(() => undefined);
  const context = asTestRaw<AuthorizedMcpRequestContext>({
    organizationId: ORGANIZATION_ID,
    recordAuditEvent,
  });
  const run = async (toolName: string, handler: McpToolHandler) =>
    await runToolWithRealtime({
      announce,
      args: {},
      context,
      handler,
      toolName,
    });
  return { announce, recordAuditEvent, run };
};

const handlerWriting =
  (...workspaceIds: (typeof WORKSPACE_ID)[]): McpToolHandler =>
  async ({ context }) => {
    for (const workspaceId of workspaceIds) {
      await bindWorkspaceRecorder(context, workspaceId)(TX, auditEvent());
    }
    return asTestRaw(SUCCESS);
  };

describe("runToolWithRealtime", () => {
  test("announces a tool's declarations in the matter its audit events name", async () => {
    const { announce, recordAuditEvent, run } = invocation();

    await run("save_document", handlerWriting(WORKSPACE_ID));

    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
    expect(announce.mock.calls.map(([options]) => options)).toEqual(
      WRITE_TOOL_REALTIME.save_document.map((realtime) =>
        expect.objectContaining({
          organizationId: ORGANIZATION_ID,
          realtime,
          workspaceId: WORKSPACE_ID,
        }),
      ),
    );
  });

  test("announces once per written matter", async () => {
    const { announce, run } = invocation();

    await run(
      "link_matter_contact",
      handlerWriting(WORKSPACE_ID, OTHER_WORKSPACE_ID, WORKSPACE_ID),
    );

    expect(announce.mock.calls.map(([{ workspaceId }]) => workspaceId)).toEqual(
      [WORKSPACE_ID, OTHER_WORKSPACE_ID],
    );
  });

  test("announces an organization-wide set without needing a matter", async () => {
    const { announce, run } = invocation();

    await run("delete_matter", handlerWriting());

    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce.mock.calls[0]?.[0].workspaceId).toBeUndefined();
  });

  test("a refused call announces nothing", async () => {
    const { announce, run } = invocation();

    await run("save_document", async ({ context }) => {
      await bindWorkspaceRecorder(context, WORKSPACE_ID)(TX, auditEvent());
      return errorResult("Forbidden");
    });

    expect(announce).not.toHaveBeenCalled();
  });

  test("a call that wrote in no matter has no audience", async () => {
    const { announce, run } = invocation();

    await run("save_document", handlerWriting());

    expect(announce).not.toHaveBeenCalled();
  });

  test("a read tool passes through", async () => {
    const { announce, run } = invocation();

    await run("read_document", handlerWriting(WORKSPACE_ID));

    expect(announce).not.toHaveBeenCalled();
  });

  test("a broadcast failure leaves the tool's result intact", async () => {
    const { announce, run } = invocation();
    announce.mockImplementation(() => {
      throw new TypeError("broadcast failed");
    });

    expect(await run("save_document", handlerWriting(WORKSPACE_ID))).toEqual(
      asTestRaw(SUCCESS),
    );
  });
});

test("both tool runners call handlers through runToolWithRealtime", async () => {
  const apiSrc = path.resolve(import.meta.dir, "..");
  for (const runner of [
    "mcp/tools.ts",
    "handlers/chat/tools/registry-adapter/run-registry-write-tool.ts",
  ]) {
    const source = await Bun.file(path.join(apiSrc, runner)).text();
    expect(source).toContain("runToolWithRealtime({");
  }
});
