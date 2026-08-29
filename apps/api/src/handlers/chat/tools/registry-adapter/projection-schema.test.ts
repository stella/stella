import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { expectTypeOf } from "expect-type";
import * as v from "valibot";

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
  REF_PROJECTION_FAILURE_MESSAGE,
  renderProjectionShape,
  strippedField,
  unenumeratedJson,
} from "@/api/lib/chat/projection-schema";
import type {
  ChatProjectionSchema,
  DehydratedInput,
} from "@/api/lib/chat/projection-schema";
import type {
  AssertNoExtraFields,
  LIST_MATTERS_LIST_PROJECTION,
  LIST_PROPERTIES_PROJECTION,
} from "@/api/lib/chat/projections";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
// The fail-closed tests assert the exact telemetry contract (paths only,
// never values) on the event the real capture path would have shipped.
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";

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

  beforeEach(() => {
    analytics = installRecordingAnalytics();
  });

  afterEach(() => {
    analytics.restore();
  });

  const exceptionProperties = () =>
    analytics.exceptions().map((event) => event.properties);

  test("an undeclared field fails the strict parse with its path, never its value", () => {
    const result = project({
      schema: LIST_MATTERS_PROJECTION,
      payload: {
        matters: [
          {
            id: WS_UUID,
            name: "Acme",
            reference: "REF-1",
            status: "active",
            lastActivityAt: "2026-01-01T00:00:00.000Z",
            createdAt: "2026-01-01T00:00:00.000Z",
            // The class under guard: a handler field nobody classified,
            // carrying a UUID. The strict parse refuses it by construction.
            plumbingId: ROGUE_UUID,
          },
        ],
        nextCursor: null,
      },
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.kind).toBe("server-defect");
      expect(result.error.message).toBe(PROJECTION_SCHEMA_FAILURE_MESSAGE);
      expect(JSON.stringify(result.error)).not.toContain(ROGUE_UUID);
    }
    const [exception] = analytics.exceptions();
    expect(exception?.properties).toMatchObject({
      "error.class": "ChatToolError",
      source: "run-registry-tool",
      toolName: "test_tool",
    });
    expect(JSON.stringify(exception?.properties)).toContain(
      "matters[].plumbingId",
    );
    expect(JSON.stringify(analytics.exceptions())).not.toContain(ROGUE_UUID);
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

  test("the UUID invariant still covers unenumeratedJson contents, unlicensed", () => {
    const schema: ChatProjectionSchema = v.strictObject({
      content: unenumeratedJson(),
    });

    const result = project({
      payload: {
        content: { nodes: [{ value: `see ${ROGUE_UUID}` }] },
      },
      schema,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.kind).toBe("server-defect");
      expect(result.error.message).toBe(REF_PROJECTION_FAILURE_MESSAGE);
    }
    expect(exceptionProperties()).toMatchObject([
      {
        "error.class": "ChatToolError",
        path: "content.nodes[].value",
        source: "run-registry-tool",
        toolName: "test_tool",
      },
    ]);
    expect(JSON.stringify(analytics.exceptions())).not.toContain(ROGUE_UUID);
  });

  test("a UUID embedded in a declared plain string fails closed with its path", () => {
    const schema: ChatProjectionSchema = v.strictObject({
      matters: v.array(v.strictObject({ reference: v.string() })),
    });

    const result = project({
      payload: { matters: [{ reference: `REF-${ROGUE_UUID}` }] },
      schema,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.message).toBe(REF_PROJECTION_FAILURE_MESSAGE);
      expect(result.error.message).not.toContain(ROGUE_UUID);
    }
    expect(exceptionProperties()).toMatchObject([
      { "error.class": "ChatToolError", path: "matters[].reference" },
    ]);
  });

  test("an entity ref whose workspace is unrecoverable fails closed instead of leaking", () => {
    // The sibling workspace slot is null, so no ref can be minted; the raw
    // entity UUID would survive at an entity-ref position, which is never
    // licensed, so the invariant refuses the payload.
    const schema: ChatProjectionSchema = v.strictObject({
      entityId: chatEntityRef({ from: "sibling", key: "workspaceId" }),
      workspaceId: v.nullable(chatRef("matter")),
    });

    const result = project({
      payload: { entityId: ENTITY_UUID, workspaceId: null },
      schema,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.kind).toBe("server-defect");
      expect(result.error.message).toBe(REF_PROJECTION_FAILURE_MESSAGE);
    }
    expect(exceptionProperties()).toMatchObject([
      { "error.class": "ChatToolError", path: "entityId" },
    ]);
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
        stripped: strippedField(),
        unenumerated: unenumeratedJson(),
      }),
    );
    type Input = v.InferInput<typeof schema>;

    expectTypeOf<Input["entityId"]>().toEqualTypeOf<SafeId<"entity">>();
    expectTypeOf<Input["matterId"]>().toEqualTypeOf<SafeId<"workspace">>();
    expectTypeOf<Input["passthrough"]>().toEqualTypeOf<string>();
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
