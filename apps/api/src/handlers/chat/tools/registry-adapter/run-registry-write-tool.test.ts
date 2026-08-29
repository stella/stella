import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ScopedDb } from "@/api/db/safe-db";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import {
  containsRawUuid,
  projectForChat,
  REF_PROJECTION_FAILURE_MESSAGE,
} from "@/api/lib/chat/projection-schema";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import type { McpRequestContext } from "@/api/mcp/context";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

import { buildMcpContextFromChat } from "./mcp-chat-context";
import { WRITE_TOOL_REF_FIELD_MAP } from "./ref-field-map";
import { dehydrateRefs } from "./ref-mediation";
import {
  applyChatApprovalConfirmation,
  runRegistryWriteTool,
} from "./run-registry-write-tool";

// The real capture path runs; only the sink is in memory, and installing per
// test clears its repeat-suppression window.
let analytics: RecordingAnalytics;

beforeEach(() => {
  analytics = installRecordingAnalytics();
});

afterEach(() => {
  analytics.restore();
});

const WS_UUID = "0dc54d0c-10d7-501d-897e-e801dbd0998c";
const OTHER_WS_UUID = "4e919658-a448-5354-8e3a-e99911214d2c";
const CONTACT_UUID = "6111c8e9-1404-5b6f-8a9a-0e3a93e8179a";

const noopScopedDb: ScopedDb = asTestRaw<ScopedDb>(
  async (run: (tx: unknown) => unknown) => await run({}),
);

const buildContext = ({
  recordAuditEvent,
}: {
  recordAuditEvent?: AuditRecorder;
} = {}): McpRequestContext =>
  buildMcpContextFromChat({
    memberRole: "owner",
    organizationId: toSafeId<"organization">("org_1"),
    pinServerValidatedWorkspaceId: () => true,
    recordAuditEvent,
    safeDb: toSafeDbMock(noopScopedDb),
    scopedDb: noopScopedDb,
    toolWorkspaceIds: resolveToolWorkspaceIds({
      accessibleWorkspaceIds: [toSafeId<"workspace">(WS_UUID)],
      pinnedIds: [],
    }),
    userId: toSafeId<"user">("user_1"),
    workspaceStatusById: new Map([[WS_UUID, "active"]]),
  });

describe("runRegistryWriteTool (orchestration)", () => {
  test("refuses a write the ref map keeps off the chat surface", async () => {
    const result = await runRegistryWriteTool({
      args: {},
      context: buildContext(),
      refRegistry: createChatRefRegistry(),
      toolName: "fill_template",
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.message).toContain("not available in chat");
    }
  });

  test("refuses a feature-gated tool whose deploy flag is off", async () => {
    const result = await runRegistryWriteTool(
      {
        args: { time_entry_id: "te-1" },
        context: buildContext(),
        refRegistry: createChatRefRegistry(),
        toolName: "delete_time_entry",
      },
      {
        isMcpToolFeatureEnabled: (feature) =>
          feature !== "FEATURE_TIME_BILLING",
      },
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.message).toContain("not enabled");
    }
  });

  test("surfaces an unknown input ref before dispatching the handler", async () => {
    // Dehydration runs before the MCP handler; an unresolvable ref fails here,
    // so a stale/typo'd ref never reaches a mutation.
    const result = await runRegistryWriteTool({
      args: { matter_id: "mat_999" },
      context: buildContext(),
      refRegistry: createChatRefRegistry(),
      toolName: "save_matter",
    });

    expect(Result.isError(result)).toBe(true);
  });

  test("injects confirm for approved chat member removals", () => {
    expect(
      applyChatApprovalConfirmation({
        args: {
          action: "remove_member",
          matter_id: WS_UUID,
          user_id: "user_2",
        },
        toolName: "manage_organization",
      }),
    ).toEqual({
      action: "remove_member",
      matter_id: WS_UUID,
      user_id: "user_2",
      confirm: true,
    });
  });
});

describe("write ref mediation (via the WRITE_TOOL_REF_FIELD_MAP)", () => {
  // These drive the exact map entries runRegistryWriteTool feeds into
  // dehydration and `projectForChat`, so they cover input dehydration and
  // output projection for writes without depending on a live MCP handler.

  test("save_matter: input refs dehydrate, the returned matter id hydrates", () => {
    const registry = createChatRefRegistry();
    const matterRef = registry.toMatterRef(toSafeId<"workspace">(WS_UUID));
    const contactRef = registry.toContactRef(toSafeId<"contact">(CONTACT_UUID));

    const dehydrated = dehydrateRefs({
      args: { matter_id: matterRef, client_id: contactRef, name: "Acme" },
      inputRefs: WRITE_TOOL_REF_FIELD_MAP.save_matter.inputRefs,
      refRegistry: registry,
    }).unwrap();
    expect(dehydrated.args["matter_id"]).toBe(WS_UUID);
    expect(dehydrated.args["client_id"]).toBe(CONTACT_UUID);
    expect(dehydrated.args["name"]).toBe("Acme");

    const projected = projectForChat({
      dehydration: dehydrated,
      payload: { matterId: WS_UUID, updated: true },
      refRegistry: registry,
      schema: WRITE_TOOL_REF_FIELD_MAP.save_matter.projection,
      source: "run-registry-write-tool",
      toolName: "save_matter",
    }).unwrap();
    expect(projected).toEqual({ matterId: matterRef, updated: true });
    expect(containsRawUuid(projected)).toBe(false);
  });

  test("set_field_value dehydrates its entity and property refs", () => {
    const registry = createChatRefRegistry();
    const entityRef = registry.toEntityRef({
      entityId: toSafeId<"entity">("c09ec856-d945-5ecc-82e3-bb5382165f34"),
      workspaceId: toSafeId<"workspace">(WS_UUID),
    });
    const propertyRef = registry.toPropertyRef(
      toSafeId<"property">("37286c24-6145-572e-ad27-15a1d4454d59"),
    );

    const dehydrated = dehydrateRefs({
      args: { entity_id: entityRef, property_id: propertyRef },
      inputRefs: WRITE_TOOL_REF_FIELD_MAP.set_field_value.inputRefs,
      refRegistry: registry,
    }).unwrap();
    expect(dehydrated.args["entity_id"]).toBe(
      "c09ec856-d945-5ecc-82e3-bb5382165f34",
    );
    expect(dehydrated.args["property_id"]).toBe(
      "37286c24-6145-572e-ad27-15a1d4454d59",
    );
  });

  test("the UUID invariant fails closed on a raw uuid in a declared plain field", () => {
    // manage_organization's settings echo declares `matterNumberPattern` as an
    // ordinary string, which no annotation licenses to carry a UUID: a raw
    // uuid there is refused rather than leaked, with only the path (never the
    // value) reaching telemetry.
    const result = projectForChat({
      dehydration: {
        args: {},
        dehydratedEntityRefs: new Map(),
        resolvedEntityParams: {},
        resolvedMatterParams: {},
      },
      payload: { matterNumberPattern: OTHER_WS_UUID },
      refRegistry: createChatRefRegistry(),
      schema: WRITE_TOOL_REF_FIELD_MAP.manage_organization.projection,
      source: "run-registry-write-tool",
      toolName: "manage_organization",
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.kind).toBe("server-defect");
      expect(result.error.message).toBe(REF_PROJECTION_FAILURE_MESSAGE);
    }
    expect(
      analytics.exceptions().map((event) => event.properties),
    ).toMatchObject([
      {
        "error.class": "ChatToolError",
        path: "matterNumberPattern",
        source: "run-registry-write-tool",
        toolName: "manage_organization",
      },
    ]);
    expect(JSON.stringify(analytics.exceptions())).not.toContain(OTHER_WS_UUID);
  });
});

describe("write MCP context wiring", () => {
  test("threads the real audit recorder so a projected write leaves an audit trail", () => {
    const recordAuditEvent: AuditRecorder = mock(async () => undefined);
    const context = buildContext({ recordAuditEvent });
    // runRegistryWriteTool passes this context straight to the MCP handler,
    // whose mutation calls `context.recordAuditEvent`; wiring the real recorder
    // here is what makes a chat-driven write auditable like an MCP/REST write.
    expect(context.recordAuditEvent).toBe(recordAuditEvent);
  });

  test("passes real per-workspace statuses so archived matters stay read-only", () => {
    const context = buildContext();
    expect(context.accessibleWorkspaceStatusById.get(WS_UUID)).toBe("active");
  });
});
