import { Result } from "better-result";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  expectTypeOf,
} from "bun:test";
import * as v from "valibot";

import {
  PUBLIC_COUNTRIES,
  publicCountryUnavailable,
} from "@stll/api-contract/public-country-capability";

import { type SafeId, toSafeId } from "@/api/lib/branded-types";
import type { PersistedJsonValue } from "@/api/lib/chat/persisted-message-content";
import {
  chatEntityRef,
  chatRef,
  containsRawUuid,
  deriveRefMediationEntry,
  passthroughId,
  PROJECTION_SCHEMA_FAILURE_MESSAGE,
  projectionBranch,
  projectForChat,
  publicUrl,
  renderProjectionShape,
  strippedField,
  unenumeratedJson,
} from "@/api/lib/chat/projection-schema";
import type {
  ChatProjectionSchema,
  DehydratedInput,
} from "@/api/lib/chat/projection-schema";
import { READ_DOCUMENT_VERSION_PROJECTION } from "@/api/lib/chat/projections";
import type {
  LIST_MATTERS_LIST_PROJECTION,
  LIST_PROPERTIES_PROJECTION,
} from "@/api/lib/chat/projections";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { TOOL_OUTPUT_CONTRACT_DEGRADED_EVENT } from "@/api/lib/chat/tool-output-degrade";
import type { AssertNoExtraFields } from "@/api/lib/projection-totality";
// The fail-closed and degrade tests assert the exact telemetry contract
// (paths only, never values) on the event the real capture path would have
// shipped.
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

import {
  READ_TOOL_REF_FIELD_MAP,
  WRITE_TOOL_REF_FIELD_MAP,
} from "./ref-field-map";

const LIST_MATTERS_PROJECTION = READ_TOOL_REF_FIELD_MAP.list_matters.projection;
const READ_DOCUMENT_PROJECTION =
  READ_TOOL_REF_FIELD_MAP.read_document.projection;

describe("projectForChat", () => {
  const WS_UUID = "0dc54d0c-10d7-501d-897e-e801dbd0998c";
  const ROGUE_UUID = "4e919658-a448-5354-8e3a-e99911214d2c";
  const ENTITY_UUID = "c09ec856-d945-5ecc-82e3-bb5382165f34";
  const LINKED_ENTITY_UUID = "1e7f7f2a-9b2b-4c40-8ab1-2f5b6c7d8e9f";
  const CONTACT_UUID = "6111c8e9-1404-5b6f-8a9a-0e3a93e8179a";
  const PROPERTY_UUID = "37286c24-6145-572e-ad27-15a1d4454d59";

  const emptyDehydration = (): DehydratedInput => ({
    args: {},
    dehydratedEntityRefs: new Map(),
    resolvedEntityParams: {},
    resolvedMatterParams: {},
  });

  type ProjectArgs = {
    schema: ChatProjectionSchema;
    payload: unknown;
    refRegistry?: ReturnType<typeof createChatRefRegistry>;
    dehydration?: DehydratedInput;
  };

  const project = ({
    schema,
    payload,
    refRegistry = createChatRefRegistry(),
    dehydration = emptyDehydration(),
  }: ProjectArgs) =>
    projectForChat({
      dehydration,
      payload,
      refRegistry,
      schema,
      source: "run-registry-tool",
      toolName: "test_tool",
    });

  // Per test: every fail-closed case captures from the same construction
  // site, which the real path throttles to one event per window.
  let analytics: RecordingAnalytics;
  let logs: RecordingLogger;

  beforeEach(() => {
    analytics = installRecordingAnalytics();
    logs = installRecordingLogger();
  });

  afterEach(() => {
    analytics.restore();
    logs.restore();
  });

  const exceptionProperties = () =>
    analytics.exceptions().map((event) => event.properties);

  /** The degrade defect reports: one ERROR log line per degraded result. */
  const degradeLogs = () =>
    logs
      .at("ERROR")
      .filter(({ message }) => message === TOOL_OUTPUT_CONTRACT_DEGRADED_EVENT)
      .map(({ attributes }) => attributes);

  /** Every telemetry record, serialized, for "no value leaked" assertions. */
  const allTelemetry = () => JSON.stringify([analytics.events, logs.records]);

  const matterRow = {
    createdAt: "2026-01-01T00:00:00.000Z",
    id: WS_UUID,
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    name: "Acme",
    reference: "REF-1",
    status: "active",
  };

  test("an undeclared field is stripped and reported by path, never by value", () => {
    const refRegistry = createChatRefRegistry();
    const result = project({
      payload: {
        // The class under guard: a handler field nobody classified, carrying
        // a UUID, inside an array item of a union branch.
        matters: [{ ...matterRow, plumbingId: ROGUE_UUID }],
        nextCursor: null,
      },
      refRegistry,
      schema: LIST_MATTERS_PROJECTION,
    });

    expect(Result.isOk(result)).toBe(true);
    const projected = result.unwrap();
    expect(projected).toEqual({
      matters: [
        {
          ...matterRow,
          id: refRegistry.toMatterRef(toSafeId<"workspace">(WS_UUID)),
        },
      ],
      nextCursor: null,
    });
    expect(containsRawUuid(projected)).toBe(false);
    expect(degradeLogs()).toEqual([
      {
        defect: "undeclared_fields",
        paths: "matters[].plumbingId",
        source: "run-registry-tool",
        tool: "test_tool",
      },
    ]);
    expect(exceptionProperties()).toMatchObject([
      {
        defect: "undeclared_fields",
        "error.class": "ToolOutputContractDegradedError",
        paths: "matters[].plumbingId",
        source: "run-registry-tool",
        toolName: "test_tool",
      },
    ]);
    expect(allTelemetry()).not.toContain(ROGUE_UUID);
  });

  test("undeclared fields are stripped at the top level and inside nested objects", () => {
    const schema: ChatProjectionSchema = v.strictObject({
      document: v.strictObject({
        title: v.string(),
        versions: v.array(v.strictObject({ label: v.string() })),
      }),
      total: v.number(),
    });

    const projected = project({
      payload: {
        document: {
          internalNote: "privileged",
          title: "NDA",
          versions: [{ label: "v1" }, { label: "v2", storageKey: "s3://x" }],
        },
        debug: { trace: true },
        total: 2,
      },
      schema,
    }).unwrap();

    expect(projected).toEqual({
      document: { title: "NDA", versions: [{ label: "v1" }, { label: "v2" }] },
      total: 2,
    });
    expect(degradeLogs()).toEqual([
      expect.objectContaining({
        paths: "document.internalNote, document.versions[].storageKey, debug",
      }),
    ]);
    expect(allTelemetry()).not.toContain("privileged");
    expect(allTelemetry()).not.toContain("s3://x");
  });

  test("a missing declared field still fails closed, with no degrade report", () => {
    const { reference: _reference, ...missingReference } = matterRow;
    const result = project({
      payload: {
        matters: [{ ...missingReference, plumbingId: ROGUE_UUID }],
        nextCursor: null,
      },
      schema: LIST_MATTERS_PROJECTION,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.kind).toBe("server-defect");
      expect(result.error.message).toBe(PROJECTION_SCHEMA_FAILURE_MESSAGE);
      expect(JSON.stringify(result.error)).not.toContain(ROGUE_UUID);
    }
    expect(degradeLogs()).toEqual([]);
    expect(exceptionProperties()).toMatchObject([
      {
        "error.class": "ChatToolError",
        source: "run-registry-tool",
        toolName: "test_tool",
      },
    ]);
    expect(allTelemetry()).not.toContain(ROGUE_UUID);
  });

  test("an invalid declared field still fails closed, alone or beside an undeclared one", () => {
    const schema: ChatProjectionSchema = v.strictObject({
      count: v.number(),
      name: v.string(),
    });

    for (const payload of [
      { count: "three", name: "Acme" },
      { count: "three", extra: true, name: "Acme" },
    ]) {
      const result = project({ payload, schema });

      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.message).toBe(PROJECTION_SCHEMA_FAILURE_MESSAGE);
      }
    }
    expect(degradeLogs()).toEqual([]);
  });

  test("an undeclared field inside a union branch is stripped against that branch", () => {
    const schema: ChatProjectionSchema = v.strictObject({
      result: v.variant("type", [
        projectionBranch(
          v.strictObject({ type: v.literal("found"), name: v.string() }),
        ),
        projectionBranch(
          v.strictObject({ type: v.literal("missing"), reason: v.string() }),
        ),
      ]),
    });

    const projected = project({
      payload: {
        result: { name: "Acme", rowVersion: 7, type: "found" },
      },
      schema,
    }).unwrap();

    expect(projected).toEqual({ result: { name: "Acme", type: "found" } });
    expect(degradeLogs()).toEqual([
      expect.objectContaining({
        defect: "undeclared_fields",
        paths: "result.rowVersion",
      }),
    ]);
  });

  test("each simple ref kind hydrates to the registry's chat ref", () => {
    const refRegistry = createChatRefRegistry();
    const matterRef = refRegistry.toMatterRef(toSafeId<"workspace">(WS_UUID));
    const contactRef = refRegistry.toContactRef(
      toSafeId<"contact">(CONTACT_UUID),
    );
    const propertyRef = refRegistry.toPropertyRef(
      toSafeId<"property">(PROPERTY_UUID),
    );
    const schema: ChatProjectionSchema = v.strictObject({
      contactId: chatRef("contact"),
      matterId: chatRef("matter"),
      propertyId: chatRef("property"),
    });

    const projected = project({
      payload: {
        contactId: CONTACT_UUID,
        matterId: WS_UUID,
        propertyId: PROPERTY_UUID,
      },
      refRegistry,
      schema,
    }).unwrap();

    expect(projected).toEqual({
      contactId: contactRef,
      matterId: matterRef,
      propertyId: propertyRef,
    });
    expect(containsRawUuid(projected)).toBe(false);
  });

  test("ref fields reject identifiers that cannot carry the SafeId brand", () => {
    const schema: ChatProjectionSchema = v.strictObject({
      entityId: chatEntityRef({ from: "sibling", key: "workspaceId" }),
      matterId: chatRef("matter"),
      workspaceId: chatRef("matter"),
    });

    for (const invalidId of ["", "\uD800"]) {
      const result = project({
        payload: {
          entityId: invalidId,
          matterId: invalidId,
          workspaceId: invalidId,
        },
        schema,
      });

      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.message).toBe(PROJECTION_SCHEMA_FAILURE_MESSAGE);
      }
    }
  });

  test("strippedField leaves are omitted, UUIDs inside them and all", () => {
    const schema: ChatProjectionSchema = v.strictObject({
      name: v.string(),
      pdfFileId: strippedField(),
      thumbnail: v.optional(strippedField()),
    });

    const projected = project({
      payload: {
        name: "NDA draft",
        pdfFileId: ROGUE_UUID,
        thumbnail: { fileId: WS_UUID },
      },
      schema,
    }).unwrap();

    expect(projected).toEqual({ name: "NDA draft" });
    expect(containsRawUuid(projected)).toBe(false);
  });

  test("passthroughId survives verbatim, UUID-shaped or not", () => {
    const schema: ChatProjectionSchema = v.strictObject({
      cursor: v.nullable(passthroughId()),
      versionId: passthroughId(),
    });

    const projected = project({
      payload: { cursor: null, versionId: WS_UUID },
      schema,
    }).unwrap();

    expect(projected).toEqual({ cursor: null, versionId: WS_UUID });
  });

  test("publicUrl forwards a publisher URL verbatim, embedded UUID and all", () => {
    const schema: ChatProjectionSchema = v.strictObject({
      sourceUrl: v.nullable(publicUrl()),
    });
    const justiceCzUrl = `https://rozhodnuti.justice.cz/api/finaldoc/${ROGUE_UUID}`;

    const projected = project({
      payload: { sourceUrl: justiceCzUrl },
      schema,
    }).unwrap();

    expect(projected).toEqual({ sourceUrl: justiceCzUrl });
  });

  test("sibling workspace source reads the raw payload, not the hydrated output", () => {
    const refRegistry = createChatRefRegistry();
    const schema: ChatProjectionSchema = v.strictObject({
      hits: v.array(
        v.strictObject({
          // Declared (and emitted) BEFORE the entity id: a walk that hydrated
          // in place would overwrite the sibling workspace UUID with `mat_N`
          // before the entity ref could read it. The raw-snapshot guarantee is
          // what this test pins.
          workspaceId: chatRef("matter"),
          entityId: chatEntityRef({ from: "sibling", key: "workspaceId" }),
          name: v.string(),
        }),
      ),
    });

    const projected = project({
      payload: {
        hits: [{ workspaceId: WS_UUID, entityId: ENTITY_UUID, name: "Brief" }],
      },
      refRegistry,
      schema,
    }).unwrap();

    expect(projected).toEqual({
      hits: [
        {
          entityId: refRegistry.toEntityRef({
            entityId: toSafeId<"entity">(ENTITY_UUID),
            workspaceId: toSafeId<"workspace">(WS_UUID),
          }),
          name: "Brief",
          workspaceId: refRegistry.toMatterRef(toSafeId<"workspace">(WS_UUID)),
        },
      ],
    });
    expect(containsRawUuid(projected)).toBe(false);
  });

  test("outputPath workspace source reads the raw payload across the tree", () => {
    const refRegistry = createChatRefRegistry();
    const schema: ChatProjectionSchema = v.strictObject({
      invoice: v.strictObject({
        workspaceId: chatRef("matter"),
        items: v.array(
          v.strictObject({
            entityId: chatEntityRef({
              from: "outputPath",
              path: "invoice.workspaceId",
            }),
          }),
        ),
      }),
    });

    const projected = project({
      payload: {
        invoice: {
          workspaceId: WS_UUID,
          items: [{ entityId: ENTITY_UUID }],
        },
      },
      refRegistry,
      schema,
    }).unwrap();

    expect(projected).toEqual({
      invoice: {
        items: [
          {
            entityId: refRegistry.toEntityRef({
              entityId: toSafeId<"entity">(ENTITY_UUID),
              workspaceId: toSafeId<"workspace">(WS_UUID),
            }),
          },
        ],
        workspaceId: refRegistry.toMatterRef(toSafeId<"workspace">(WS_UUID)),
      },
    });
    expect(containsRawUuid(projected)).toBe(false);
  });

  test("inputParam workspace source draws from the resolved matter input", () => {
    const refRegistry = createChatRefRegistry();
    const schema: ChatProjectionSchema = v.strictObject({
      documents: v.array(
        v.strictObject({
          id: chatEntityRef({ from: "inputParam", param: "matter_id" }),
        }),
      ),
    });

    const projected = project({
      dehydration: {
        ...emptyDehydration(),
        resolvedMatterParams: { matter_id: toSafeId<"workspace">(WS_UUID) },
      },
      payload: { documents: [{ id: ENTITY_UUID }] },
      refRegistry,
      schema,
    }).unwrap();

    expect(projected).toEqual({
      documents: [
        {
          id: refRegistry.toEntityRef({
            entityId: toSafeId<"entity">(ENTITY_UUID),
            workspaceId: toSafeId<"workspace">(WS_UUID),
          }),
        },
      ],
    });
  });

  test("inputEntityWorkspace mints a new ref for a different entity in the input entity's workspace", () => {
    const refRegistry = createChatRefRegistry();
    const taskRef = refRegistry.toEntityRef({
      entityId: toSafeId<"entity">(ENTITY_UUID),
      workspaceId: toSafeId<"workspace">(WS_UUID),
    });
    const schema: ChatProjectionSchema = v.strictObject({
      taskId: chatEntityRef({ from: "inputEntity", param: "task_id" }),
      linked: v.strictObject({
        id: chatEntityRef({ from: "inputEntityWorkspace", param: "task_id" }),
      }),
    });

    const projected = project({
      dehydration: {
        ...emptyDehydration(),
        dehydratedEntityRefs: new Map([[ENTITY_UUID, taskRef]]),
        resolvedEntityParams: { task_id: toSafeId<"workspace">(WS_UUID) },
      },
      payload: { taskId: ENTITY_UUID, linked: { id: LINKED_ENTITY_UUID } },
      refRegistry,
      schema,
    }).unwrap();

    // The task's own id echoes the dehydrated input ref (no workspace lookup);
    // the linked entity (a different uuid) mints a new ref scoped to the same
    // workspace, not the task's own ref and not an un-hydrated raw uuid.
    expect(projected).toEqual({
      linked: {
        id: refRegistry.toEntityRef({
          entityId: toSafeId<"entity">(LINKED_ENTITY_UUID),
          workspaceId: toSafeId<"workspace">(WS_UUID),
        }),
      },
      taskId: taskRef,
    });
    expect(containsRawUuid(projected)).toBe(false);
  });

  test("list_tasks hands each assignee to the model with the userId a person link needs", () => {
    const refRegistry = createChatRefRegistry();
    const taskRef = refRegistry.toEntityRef({
      entityId: toSafeId<"entity">(ENTITY_UUID),
      workspaceId: toSafeId<"workspace">(WS_UUID),
    });
    const USER_ID = "b2b7c1d0-5d1e-4f63-9a1c-0f8e7d6c5b4a";

    const projected = project({
      dehydration: {
        ...emptyDehydration(),
        dehydratedEntityRefs: new Map([[ENTITY_UUID, taskRef]]),
        resolvedEntityParams: { task_id: toSafeId<"workspace">(WS_UUID) },
      },
      payload: {
        task: {
          taskId: ENTITY_UUID,
          name: "Call the counterparty",
          status: "todo",
          priority: null,
          itemType: "task",
          dueDate: null,
          startAt: null,
          endAt: null,
          location: null,
          agendaKind: null,
          assignees: [{ userId: USER_ID, name: "jankubica96", role: "owner" }],
          links: [],
        },
      },
      refRegistry,
      schema: READ_TOOL_REF_FIELD_MAP.list_tasks.projection,
    }).unwrap();

    // The userId is the person's reference: the prompt's PEOPLE MENTIONS rule
    // links the name as `[jankubica96](#stella-user=<userId>)`.
    expect(projected).toMatchObject({
      task: {
        taskId: taskRef,
        assignees: [{ userId: USER_ID, name: "jankubica96", role: "owner" }],
      },
    });
  });

  test("a person field keeps its userId, so the model can link the person", () => {
    const USER_ID = "b2b7c1d0-5d1e-4f63-9a1c-0f8e7d6c5b4a";
    const refRegistry = createChatRefRegistry();
    const documentRef = refRegistry.toEntityRef({
      entityId: toSafeId<"entity">(ENTITY_UUID),
      workspaceId: toSafeId<"workspace">(WS_UUID),
    });

    const projected = project({
      dehydration: {
        ...emptyDehydration(),
        dehydratedEntityRefs: new Map([[ENTITY_UUID, documentRef]]),
        resolvedEntityParams: { entity_id: toSafeId<"workspace">(WS_UUID) },
      },
      payload: {
        entityId: ENTITY_UUID,
        name: "Lease",
        version: {
          id: "version-1",
          versionNumber: 1,
          stamp: null,
          label: null,
          description: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          fields: [
            {
              id: "field-1",
              propertyId: PROPERTY_UUID,
              content: {
                version: 1,
                type: "person",
                userId: USER_ID,
                name: "Jan Kubica",
                image: "https://cdn.example.test/avatar.png",
              },
            },
          ],
        },
      },
      refRegistry,
      schema: READ_DOCUMENT_VERSION_PROJECTION,
    }).unwrap();

    expect(projected).toMatchObject({
      version: {
        fields: [
          {
            content: {
              version: 1,
              type: "person",
              userId: USER_ID,
              name: "Jan Kubica",
            },
          },
        ],
      },
    });
    // The avatar URL is still web-UI plumbing the model never sees.
    expect(JSON.stringify(projected)).not.toContain("avatar.png");
  });

  test("an entity echo reuses the dehydrated ref even under another workspace source", () => {
    const refRegistry = createChatRefRegistry();
    const entityRef = refRegistry.toEntityRef({
      entityId: toSafeId<"entity">(ENTITY_UUID),
      workspaceId: toSafeId<"workspace">(WS_UUID),
    });
    // read_content_across_matters-style: the field declares a sibling source
    // for non-echo payloads, but the output entity IS the request's own input,
    // so the reuse map wins without consulting the sibling.
    const schema: ChatProjectionSchema = v.strictObject({
      entityId: chatEntityRef({ from: "sibling", key: "workspaceId" }),
      workspaceId: chatRef("matter"),
    });

    const projected = project({
      dehydration: {
        ...emptyDehydration(),
        dehydratedEntityRefs: new Map([[ENTITY_UUID, entityRef]]),
      },
      payload: { entityId: ENTITY_UUID, workspaceId: WS_UUID },
      refRegistry,
      schema,
    }).unwrap();

    expect(projected).toEqual({
      entityId: entityRef,
      workspaceId: refRegistry.toMatterRef(toSafeId<"workspace">(WS_UUID)),
    });
  });

  test("unenumeratedJson passes through unmodified when it carries no UUID", () => {
    const schema: ChatProjectionSchema = v.strictObject({
      content: unenumeratedJson(),
      question: v.string(),
    });
    const content = {
      nodes: [{ kind: "text", value: "Limitation of liability" }],
      type: "single-select",
    };

    const projected = project({
      payload: { content, question: "Which cap applies?" },
      schema,
    }).unwrap();

    expect(projected).toEqual({ content, question: "Which cap applies?" });
  });

  test("the UUID invariant still covers unenumeratedJson contents: the leaf is dropped", () => {
    const schema: ChatProjectionSchema = v.strictObject({
      content: unenumeratedJson(),
    });

    const projected = project({
      payload: {
        content: {
          nodes: [{ kind: "text", value: `see ${ROGUE_UUID}` }],
          tags: ["kept", ROGUE_UUID],
        },
      },
      schema,
    }).unwrap();

    expect(projected).toEqual({
      content: { nodes: [{ kind: "text" }], tags: ["kept"] },
    });
    expect(containsRawUuid(projected)).toBe(false);
    expect(degradeLogs()).toEqual([
      {
        defect: "unmapped_id",
        paths: "content.nodes[].value, content.tags[]",
        source: "run-registry-tool",
        tool: "test_tool",
      },
    ]);
    expect(exceptionProperties()).toMatchObject([
      {
        defect: "unmapped_id",
        "error.class": "ToolOutputContractDegradedError",
        paths: "content.nodes[].value, content.tags[]",
      },
    ]);
    expect(allTelemetry()).not.toContain(ROGUE_UUID);
  });

  test("a UUID embedded in a declared plain string drops that field, reported by path", () => {
    const schema: ChatProjectionSchema = v.strictObject({
      matters: v.array(
        v.strictObject({ name: v.string(), reference: v.string() }),
      ),
    });

    const projected = project({
      payload: {
        matters: [
          { name: "Acme", reference: `REF-${ROGUE_UUID}` },
          { name: "Beta", reference: "REF-2" },
        ],
      },
      schema,
    }).unwrap();

    // The required `reference` is dropped rather than leaked: the model sees
    // less, never the raw id.
    expect(projected).toEqual({
      matters: [{ name: "Acme" }, { name: "Beta", reference: "REF-2" }],
    });
    expect(containsRawUuid(projected)).toBe(false);
    expect(degradeLogs()).toEqual([
      expect.objectContaining({
        defect: "unmapped_id",
        paths: "matters[].reference",
      }),
    ]);
    expect(allTelemetry()).not.toContain(ROGUE_UUID);
  });

  test("a bare string array item carrying a UUID is removed from the array", () => {
    const schema: ChatProjectionSchema = v.strictObject({
      labels: v.array(v.string()),
    });

    const projected = project({
      payload: { labels: ["urgent", `ref ${ROGUE_UUID}`, "nda"] },
      schema,
    }).unwrap();

    expect(projected).toEqual({ labels: ["urgent", "nda"] });
    expect(containsRawUuid(projected)).toBe(false);
    expect(degradeLogs()).toEqual([
      expect.objectContaining({ defect: "unmapped_id", paths: "labels[]" }),
    ]);
  });

  test("an entity ref whose workspace is unrecoverable is dropped instead of leaking", () => {
    // The sibling workspace slot is null, so no ref can be minted; the raw
    // entity UUID would survive at an entity-ref position, which is never
    // licensed, so the leaf is dropped.
    const schema: ChatProjectionSchema = v.strictObject({
      entityId: chatEntityRef({ from: "sibling", key: "workspaceId" }),
      workspaceId: v.nullable(chatRef("matter")),
    });

    const projected = project({
      payload: { entityId: ENTITY_UUID, workspaceId: null },
      schema,
    }).unwrap();

    expect(projected).toEqual({ workspaceId: null });
    expect(containsRawUuid(projected)).toBe(false);
    expect(degradeLogs()).toEqual([
      expect.objectContaining({ defect: "unmapped_id", paths: "entityId" }),
    ]);
    expect(allTelemetry()).not.toContain(ENTITY_UUID);
  });

  test("a matching payload with no ids projects to the declared shape verbatim", () => {
    const payload = {
      matters: [
        {
          id: WS_UUID,
          name: "Acme",
          reference: "REF-1",
          status: "active",
          lastActivityAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    };
    const refRegistry = createChatRefRegistry();

    const projected = project({
      payload,
      refRegistry,
      schema: LIST_MATTERS_PROJECTION,
    }).unwrap();

    expect(projected).toEqual({
      matters: [
        {
          id: refRegistry.toMatterRef(toSafeId<"workspace">(WS_UUID)),
          name: "Acme",
          reference: "REF-1",
          status: "active",
          lastActivityAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
    expect(containsRawUuid(projected)).toBe(false);
  });

  test("a union branch is not parsed again during projection", () => {
    let validationRuns = 0;
    const schema: ChatProjectionSchema = v.union([
      projectionBranch(
        v.strictObject({
          type: v.literal("checked"),
          value: v.pipe(
            v.string(),
            v.check((value) => {
              validationRuns += 1;
              return value.length > 0;
            }),
          ),
        }),
      ),
      projectionBranch(
        v.strictObject({
          type: v.literal("other"),
          value: v.string(),
        }),
      ),
    ]);

    const projected = project({
      payload: { type: "checked", value: "once" },
      schema,
    }).unwrap();

    expect(projected).toEqual({ type: "checked", value: "once" });
    expect(validationRuns).toBe(1);
  });

  test("every registered union branch records its parse proof", () => {
    for (const fieldMap of [
      READ_TOOL_REF_FIELD_MAP,
      WRITE_TOOL_REF_FIELD_MAP,
    ]) {
      for (const entry of Object.values(fieldMap)) {
        if (entry.chatProjectable) {
          expect(() => deriveRefMediationEntry(entry.projection)).not.toThrow();
        }
      }
    }
  });

  test("public law projections preserve every unavailable country response", () => {
    const projections = [
      READ_TOOL_REF_FIELD_MAP.search_case_law.projection,
      READ_TOOL_REF_FIELD_MAP.lookup_case_law.projection,
      READ_TOOL_REF_FIELD_MAP.search_legislation.projection,
    ];
    for (const country of PUBLIC_COUNTRIES) {
      const payload = publicCountryUnavailable(country);
      if (payload === null) {
        continue;
      }
      for (const schema of projections) {
        expect(project({ schema, payload }).unwrap()).toEqual(payload);
      }
    }
  });

  test("an unwrapped union branch fails before projection", () => {
    const schema: ChatProjectionSchema = v.union([
      v.strictObject({ type: v.literal("unwrapped") }),
    ]);

    expect(() => deriveRefMediationEntry(schema)).toThrow(
      "chat projection union option is not wrapped in projectionBranch",
    );
  });

  test("a bare unknown leaf cannot bypass the JSON or strip contracts", () => {
    const schema: ChatProjectionSchema = v.strictObject({
      payload: v.unknown(),
    });

    expect(() => deriveRefMediationEntry(schema)).toThrow(
      "unknown chat projection fields must use strippedField or unenumeratedJson",
    );
  });

  test("unenumerated subtrees reject values that cannot cross a JSON boundary", () => {
    const schema: ChatProjectionSchema = v.strictObject({
      metadata: unenumeratedJson(),
    });
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    for (const metadata of [1n, () => undefined, cyclic]) {
      const result = project({ payload: { metadata }, schema });

      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.message).toBe(PROJECTION_SCHEMA_FAILURE_MESSAGE);
      }
    }
  });
});

describe("renderProjectionShape", () => {
  test("read_document renders a terse shape naming the model-facing keys", () => {
    const shape = renderProjectionShape(READ_DOCUMENT_PROJECTION);

    expect(shape).toContain("entityId");
    expect(shape).toContain("fields: { id, propertyId, content: … }[]");
    expect(shape).toContain("versions?");
    expect(shape).toContain("versionsNextCursor?");
    expect(shape).toContain("diff");
    // Stripped file plumbing must not be advertised to the model.
    expect(shape).not.toContain("sha256Hex");
    expect(shape).not.toContain("pdfFileId");
  });

  test("list_matters renders both branches joined as a union", () => {
    const shape = renderProjectionShape(LIST_MATTERS_PROJECTION);

    expect(shape).toContain(
      "matters: { id, name, reference, status, lastActivityAt, createdAt }[]",
    );
    expect(shape).toContain(" | ");
    expect(shape).toContain("contacts");
    // Stripped overview plumbing must not be advertised either.
    expect(shape).not.toContain("fieldId");
  });
});

/**
 * The compile-time half of the contract the runtime strict parse enforces: a
 * handler payload carrying a field its projection does not classify must fail
 * typecheck at the construction site, not at runtime in chat. Both tie
 * mechanisms are exercised: `satisfies` for object-literal payloads (excess
 * property checking) and `AssertNoExtraFields` for payloads a shared helper
 * builds. Nothing here runs; a `@ts-expect-error` whose error never
 * materializes is itself a typecheck failure, which is the assertion.
 */
describe("compile-time payload ties", () => {
  test("annotated fields retain their precise input types", () => {
    const schema = projectionBranch(
      v.strictObject({
        entityId: chatEntityRef({ from: "inputParam", param: "matter_id" }),
        matterId: chatRef("matter"),
        passthrough: passthroughId(),
        publicSourceUrl: publicUrl(),
        stripped: strippedField(),
        unenumerated: unenumeratedJson(),
      }),
    );
    type Input = v.InferInput<typeof schema>;

    expectTypeOf<Input["entityId"]>().toEqualTypeOf<SafeId<"entity">>();
    expectTypeOf<Input["matterId"]>().toEqualTypeOf<SafeId<"workspace">>();
    expectTypeOf<Input["passthrough"]>().toEqualTypeOf<string>();
    expectTypeOf<Input["publicSourceUrl"]>().toEqualTypeOf<string>();
    expectTypeOf<Input["stripped"]>().toEqualTypeOf<unknown>();
    expectTypeOf<Input["unenumerated"]>().toEqualTypeOf<unknown>();
    expectTypeOf<
      v.InferOutput<typeof schema>["unenumerated"]
    >().toEqualTypeOf<PersistedJsonValue>();
  });

  test("an unclassified field fails against the projection input", () => {
    const withExtraField = {
      matters: [],
      nextCursor: null,
      // @ts-expect-error `totalCount` is not declared by the list branch.
      totalCount: 0,
    } satisfies v.InferInput<typeof LIST_MATTERS_LIST_PROJECTION>;

    const withoutExtraField = {
      matters: [],
      nextCursor: null,
    } satisfies v.InferInput<typeof LIST_MATTERS_LIST_PROJECTION>;

    // Payloads a helper builds get the same guard through AssertNoExtraFields,
    // which names the offending keys instead of relying on literal freshness.
    const namedWithExtraField: AssertNoExtraFields<
      // @ts-expect-error `total` is not declared by LIST_PROPERTIES_PROJECTION.
      { properties: []; nextCursor: null; total: number },
      v.InferInput<typeof LIST_PROPERTIES_PROJECTION>
    > = { properties: [], nextCursor: null, total: 0 };

    const namedWithoutExtraField: AssertNoExtraFields<
      { properties: []; nextCursor: null },
      v.InferInput<typeof LIST_PROPERTIES_PROJECTION>
    > = { properties: [], nextCursor: null };

    expect(withExtraField.matters).toEqual(withoutExtraField.matters);
    expect(namedWithExtraField.properties).toEqual(
      namedWithoutExtraField.properties,
    );
  });
});
