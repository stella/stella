import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ScopedDb } from "@/api/db/safe-db";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { toSafeId } from "@/api/lib/branded-types";
import {
  containsRawUuid,
  PROJECTION_SCHEMA_FAILURE_MESSAGE,
} from "@/api/lib/chat/projection-schema";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import type { McpRequestContext } from "@/api/mcp/context";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

import { buildMcpContextFromChat } from "./mcp-chat-context";
import { dehydrateInputRefs } from "./ref-mediation";
import { runRegistryReadTool } from "./run-registry-tool";

const WS_UUID = "0dc54d0c-10d7-501d-897e-e801dbd0998c";
const OTHER_WS_UUID = "4e919658-a448-5354-8e3a-e99911214d2c";

/** A scopedDb whose select chain resolves to the seeded matter rows. */
const selectScopedDb = (rows: readonly unknown[]): ScopedDb =>
  asTestRaw<ScopedDb>(async (run: (tx: unknown) => unknown) => {
    const builder = {
      select: () => builder,
      from: () => builder,
      where: () => builder,
      orderBy: () => builder,
      limit: async () => rows,
    };
    return await run(builder);
  });

const buildContext = ({
  accessibleWorkspaceIds = [toSafeId<"workspace">(WS_UUID)],
  scopedDb = selectScopedDb([]),
}: {
  accessibleWorkspaceIds?: ReturnType<typeof toSafeId<"workspace">>[];
  scopedDb?: ScopedDb;
} = {}): McpRequestContext =>
  buildMcpContextFromChat({
    memberRole: "owner",
    organizationId: toSafeId<"organization">("org_1"),
    safeDb: toSafeDbMock(scopedDb),
    scopedDb,
    toolWorkspaceIds: resolveToolWorkspaceIds({
      accessibleWorkspaceIds,
      pinnedIds: [],
    }),
    userId: toSafeId<"user">("user_1"),
  });

describe("runRegistryReadTool", () => {
  // Per test: the real capture path throttles identical errors to one event
  // per window, and installing clears that window state.
  let analytics: RecordingAnalytics;

  beforeEach(() => {
    analytics = installRecordingAnalytics();
  });

  afterEach(() => {
    analytics.restore();
  });

  test("runs list_matters end-to-end: output UUIDs become refs, input ref dehydrates", async () => {
    const registry = createChatRefRegistry();
    const rows = [
      {
        id: WS_UUID,
        name: "Acme",
        reference: "REF-1",
        status: "active",
        lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ];

    const result = await runRegistryReadTool({
      args: {},
      context: buildContext({ scopedDb: selectScopedDb(rows) }),
      refRegistry: registry,
      toolName: "list_matters",
    });

    expect(Result.isError(result)).toBe(false);
    const payload = result.unwrap();
    // The matter's workspace UUID is replaced by its chat ref in the output.
    expect(payload).toMatchObject({
      matters: [{ id: "mat_1", name: "Acme", reference: "REF-1" }],
    });
    // The whole model-facing payload is free of raw UUIDs.
    expect(containsRawUuid(payload)).toBe(false);

    // A ref arg dehydrates back to its UUID before the handler sees it. The
    // registry already minted mat_1 while hydrating the output above.
    const dehydrated = dehydrateInputRefs({
      args: { matter_id: "mat_1" },
      refRegistry: registry,
      toolName: "list_matters",
    }).unwrap();
    expect(dehydrated.args["matter_id"]).toBe(WS_UUID);
  });

  test("maps an isError registry result to a ChatToolError", async () => {
    const registry = createChatRefRegistry();
    // A ref to a workspace that is NOT in the accessible set: detail mode
    // rejects it as not-found/not-accessible before touching the DB.
    const matterRef = registry.toMatterRef(
      toSafeId<"workspace">(OTHER_WS_UUID),
    );

    const result = await runRegistryReadTool({
      args: { matter_id: matterRef },
      context: buildContext(),
      refRegistry: registry,
      toolName: "list_matters",
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.message).toContain("not accessible");
    }
  });

  test("fails closed when a raw uuid survives ref hydration at an undeclared path", async () => {
    const registry = createChatRefRegistry();
    // Doctored: `reference` is an ordinary free-text field the ref map never
    // mediates (it is not one of `list_matters`'s `outputRefs` or
    // `passthroughIdPaths`), but nothing stops it from holding a raw uuid.
    // The path-aware backstop must catch this survivor at its exact path even
    // though no per-field ref rule exists for it.
    const rows = [
      {
        id: WS_UUID,
        name: "Acme",
        reference: OTHER_WS_UUID,
        status: "active",
        lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ];

    const result = await runRegistryReadTool({
      args: {},
      context: buildContext({ scopedDb: selectScopedDb(rows) }),
      refRegistry: registry,
      toolName: "list_matters",
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.message).not.toContain(WS_UUID);
      expect(result.error.message).not.toContain(OTHER_WS_UUID);
      // The backstop refusal is a Stella bug, not a caller mistake: the kind
      // drives the orchestrator's mechanical no-retry policy.
      expect(result.error.kind).toBe("server-defect");
    }
    // Telemetry carries the offending path so the survivor is traceable, but
    // never the leaked value itself.
    expect(
      analytics.exceptions().map((event) => event.properties),
    ).toMatchObject([
      {
        "error.class": "ChatToolError",
        path: "matters[].reference",
        source: "run-registry-tool",
        toolName: "list_matters",
      },
    ]);
    expect(JSON.stringify(analytics.exceptions())).not.toContain(OTHER_WS_UUID);
  });

  // A scopedDb whose relational query double serves read_document's two
  // entity reads (workspace resolution, then the current-version load) from
  // one superset row, mirroring the contract corpus' fixture style.
  const readDocumentScopedDb = (fieldRows: readonly unknown[]): ScopedDb => {
    const tx = {
      query: {
        entities: {
          findFirst: async () => ({
            createdAt: new Date("2025-12-01T00:00:00.000Z"),
            workspaceId: WS_UUID,
            kind: "document",
            name: "NDA draft",
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            extractedContent: null,
            currentVersion: {
              id: "version-1",
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              fields: fieldRows,
            },
            versions: [{ id: "version-1" }],
          }),
        },
        documentProcessingRuns: { findMany: async () => [] },
        entityVersions: { findFirst: async () => ({ id: "version-1" }) },
        extractedContent: { findFirst: async () => null },
        organizationSettings: {
          findFirst: async () => ({ documentProcessingMode: "off" }),
        },
        searchDocuments: { findFirst: async () => undefined },
      },
    };
    return asTestRaw<ScopedDb>(
      async (run: (transaction: unknown) => unknown) => await run(tx),
    );
  };

  const FIELD_UUID = "37286c24-6145-572e-ad27-15a1d4454d59";
  const PROPERTY_UUID = "6111c8e9-1404-5b6f-8a9a-0e3a93e8179a";
  const ENTITY_UUID = "c09ec856-d945-5ecc-82e3-bb5382165f34";

  test("strict projection parse refuses an undeclared handler field before it can flow", async () => {
    const registry = createChatRefRegistry();
    const entityRef = registry.toEntityRef({
      entityId: toSafeId<"entity">(ENTITY_UUID),
      workspaceId: toSafeId<"workspace">(WS_UUID),
    });
    // Doctored field row: `extractorRunId` is a handler field nobody
    // classified in the projection schema, carrying a UUID. Unlike the
    // runtime backstop (which only fires on UUID-shaped values), the strict
    // parse refuses the undeclared KEY itself, so the class is closed even
    // for payload slots that happen to be null or non-UUID today.
    const result = await runRegistryReadTool({
      args: { entity_id: entityRef },
      context: buildContext({
        scopedDb: readDocumentScopedDb([
          {
            id: FIELD_UUID,
            propertyId: PROPERTY_UUID,
            content: { version: 1, type: "text", value: "Body text" },
            extractorRunId: OTHER_WS_UUID,
          },
        ]),
      }),
      refRegistry: registry,
      toolName: "read_document",
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.kind).toBe("server-defect");
      expect(result.error.message).toBe(PROJECTION_SCHEMA_FAILURE_MESSAGE);
      expect(result.error.message).not.toContain(OTHER_WS_UUID);
    }
    // Telemetry carries the offending path(s), never the refused value.
    const [exception] = analytics.exceptions();
    expect(exception?.properties).toMatchObject({
      "error.class": "ChatToolError",
      source: "run-registry-tool",
      toolName: "read_document",
    });
    expect(JSON.stringify(exception?.properties)).toContain(
      "fields[].extractorRunId",
    );
    expect(JSON.stringify(analytics.exceptions())).not.toContain(OTHER_WS_UUID);
  });

  test("file-content plumbing UUIDs are stripped from the projected payload", async () => {
    const registry = createChatRefRegistry();
    const entityRef = registry.toEntityRef({
      entityId: toSafeId<"entity">(ENTITY_UUID),
      workspaceId: toSafeId<"workspace">(WS_UUID),
    });
    // The second prod backstop trip: a file field's `content.id`/
    // `content.pdfFileId` UUIDs. The projection schema declares them as
    // stripped, so the call succeeds and the plumbing never reaches the model.
    const result = await runRegistryReadTool({
      args: { entity_id: entityRef },
      context: buildContext({
        scopedDb: readDocumentScopedDb([
          {
            id: FIELD_UUID,
            propertyId: PROPERTY_UUID,
            content: {
              version: 1,
              type: "file",
              id: OTHER_WS_UUID,
              fileName: "nda.docx",
              mimeType:
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              sizeBytes: 1234,
              encrypted: false,
              sha256Hex: "a".repeat(64),
              pdfFileId: OTHER_WS_UUID,
              pdfDerivative: { status: "ready" },
              thumbnailFileId: null,
            },
          },
        ]),
      }),
      refRegistry: registry,
      toolName: "read_document",
    });

    expect(Result.isError(result)).toBe(false);
    expect(result.unwrap()).toEqual({
      contentState: {
        source: "direct_docx",
        sourceVersionId: "version-1",
        status: "ready",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      entityId: entityRef,
      kind: "document",
      name: "NDA draft",
      fields: [
        {
          // Field-row handle: declared passthrough, survives verbatim.
          id: FIELD_UUID,
          propertyId: "prop_1",
          content: {
            version: 1,
            type: "file",
            fileName: "nda.docx",
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            sizeBytes: 1234,
            encrypted: false,
          },
        },
      ],
      searchIndexState: {
        sourceVersionId: "version-1",
        status: "pending",
      },
    });
  });

  test("refuses a read tool the ref map keeps off the chat surface", async () => {
    const result = await runRegistryReadTool({
      args: {},
      context: buildContext(),
      refRegistry: createChatRefRegistry(),
      toolName: "list_audit_log",
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.message).toContain("not available in chat");
      expect(result.error.kind).toBe("unavailable");
    }
  });

  test("classifies a structured registry error envelope by its code", async () => {
    const registry = createChatRefRegistry();
    // Detail mode for an inaccessible workspace returns the handler's own
    // structured not_found envelope, which must classify as `not-found`
    // rather than the blocking `server-defect`.
    const matterRef = registry.toMatterRef(
      toSafeId<"workspace">(OTHER_WS_UUID),
    );

    const result = await runRegistryReadTool({
      args: { matter_id: matterRef },
      context: buildContext(),
      refRegistry: registry,
      toolName: "list_matters",
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.kind).toBe("not-found");
    }
  });
});
