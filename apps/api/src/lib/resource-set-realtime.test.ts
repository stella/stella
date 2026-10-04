import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { status } from "elysia";

import { RESOURCE_TYPE, type ResourceType } from "@stll/api-contract";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import {
  ACCOUNT_ACCESS,
  createSafeHandler,
  createSafeRootHandler,
  type WorkspaceHandlerConfig,
} from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  announceResourceSetUpdates,
  noResourceSetUpdates,
  organizationResourceSetUpdates,
  workspaceResourceSetUpdates,
} from "@/api/lib/resource-set-realtime";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// The broadcast decision for every transport lives in the safe-handler
// wrapper: REST routes and `invoke_capability` both call `endpoint.handler`.
// These tests drive that wrapper with recording broadcasters; the real
// transports and the real event stream are covered in
// `resource-set-realtime.db.test.ts`.

const WORKSPACE_ID = toSafeId<"workspace">(
  "019e7000-0000-7000-8000-0000000000a1",
);
const ORGANIZATION_ID = toSafeId<"organization">(
  "019e7000-0000-7000-8000-0000000000a2",
);
const USER_ID = toSafeId<"user">("019e7000-0000-7000-8000-0000000000a3");

type Announcement =
  | { audience: "workspace"; id: SafeId<"workspace">; type: ResourceType }
  | {
      audience: "organization";
      id: SafeId<"organization">;
      type: ResourceType;
    };

const recorder = () => {
  const announcements: Announcement[] = [];
  const announce: typeof announceResourceSetUpdates = (options) =>
    announceResourceSetUpdates({
      ...options,
      broadcasts: {
        workspace: (id, type) => {
          announcements.push({ audience: "workspace", id, type });
        },
        organization: (id, type) => {
          announcements.push({ audience: "organization", id, type });
        },
      },
    });
  return { announcements, announce };
};

// Failure paths log and capture by design; keep them out of the test output.
let restoreTelemetry: () => void = () => undefined;
beforeEach(() => {
  const logger = installRecordingLogger();
  const analytics = installRecordingAnalytics();
  restoreTelemetry = () => {
    logger.restore();
    analytics.restore();
  };
});
afterEach(() => {
  restoreTelemetry();
});

const noopAuditRecorder: AuditRecorder = async () => undefined;
const unusedSafeDb: SafeDb = async <T>() =>
  Result.err<T, SafeDbError>(
    new DatabaseError({ message: "db should not be read" }),
  );

const requestContext = ({
  withMemberRole = true,
}: { withMemberRole?: boolean } = {}) => ({
  request: new Request("https://example.test/resource-set-realtime"),
  route: "/resource-set-realtime",
  workspaceId: WORKSPACE_ID,
  user: { id: USER_ID, email: "standard@example.test" },
  session: { activeOrganizationId: ORGANIZATION_ID },
  ...(withMemberRole ? { memberRole: sessionMemberRole("owner") } : {}),
  safeDb: unusedSafeDb,
  scopedDb: async () => {
    throw new DatabaseError({ message: "scopedDb should not be called" });
  },
  getActiveWorkspaceIds: async () => [],
  getAccessibleWorkspaces: async () => [],
  getWorkspaceAccess: async () => null,
  pinServerValidatedWorkspaceId: () => false,
  orgAIConfig: null,
  orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
  managedAIResidency: "eu" as const,
  promptCachingEnabled: false,
  recordAuditEvent: noopAuditRecorder,
  createAuditRecorder: () => noopAuditRecorder,
});

const baseConfig = {
  permissions: { workspace: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "health_infra" },
} satisfies WorkspaceHandlerConfig;

describe("a matter handler's declared resource sets", () => {
  for (const realtime of [
    undefined,
    noResourceSetUpdates("Owned by the handler"),
  ]) {
    test(`a handler with ${realtime?.scope ?? "undeclared"} announcements needs no broadcast context`, async () => {
      const { session: _session, ...context } = requestContext();
      let attempts = 0;
      const endpoint = createSafeHandler(
        realtime === undefined ? baseConfig : { ...baseConfig, realtime },
        async function* () {
          return Result.ok({ ok: true });
        },
        {
          announce: () => {
            attempts += 1;
          },
        },
      );

      expect(await endpoint.handler(asTestRaw(context))).toEqual({ ok: true });
      expect(attempts).toBe(0);
    });
  }

  for (const realtime of [
    workspaceResourceSetUpdates(RESOURCE_TYPE.ENTITY),
    organizationResourceSetUpdates(RESOURCE_TYPE.AGENT_SKILL),
  ]) {
    test(`a ${realtime.scope} broadcast failure preserves the committed result and is captured`, async () => {
      const analytics = installRecordingAnalytics();
      const logs = installRecordingLogger();
      let committed = false;
      let attempts = 0;
      const payload = { ok: true };
      const endpoint = createSafeHandler(
        { ...baseConfig, realtime },
        async function* () {
          committed = true;
          return Result.ok(payload);
        },
        {
          announce: () => {
            expect(committed).toBe(true);
            attempts += 1;
            throw new DatabaseError({ message: "broadcast unavailable" });
          },
        },
      );

      try {
        expect(await endpoint.handler(asTestRaw(requestContext()))).toBe(
          payload,
        );
        expect(attempts).toBe(1);
        expect(analytics.exceptions()).toHaveLength(1);
        expect(analytics.exceptions().at(0)?.properties).toMatchObject({
          "error.cause.class": "DatabaseError",
        });
        expect(logs.at("ERROR").at(0)?.attributes).toMatchObject({
          "failure.sink": "resource-set-realtime.announce",
        });
      } finally {
        logs.restore();
        analytics.restore();
      }
    });
  }

  test("a success announces each declared set once to the handler's matter", async () => {
    const { announcements, announce } = recorder();
    const endpoint = createSafeHandler(
      {
        ...baseConfig,
        realtime: workspaceResourceSetUpdates([
          RESOURCE_TYPE.ENTITY,
          RESOURCE_TYPE.USER_FILE,
          RESOURCE_TYPE.ENTITY,
        ]),
      },
      async function* () {
        // The announcement waits for the handler to finish: nothing has been
        // broadcast while the handler is still running.
        expect(announcements).toEqual([]);
        return Result.ok({ ok: true });
      },
      { announce },
    );

    const result = await endpoint.handler(asTestRaw(requestContext()));

    expect(result).toEqual({ ok: true });
    expect(announcements).toEqual([
      { audience: "workspace", id: WORKSPACE_ID, type: RESOURCE_TYPE.ENTITY },
      {
        audience: "workspace",
        id: WORKSPACE_ID,
        type: RESOURCE_TYPE.USER_FILE,
      },
    ]);
  });

  test("a typed refusal announces nothing", async () => {
    const { announcements, announce } = recorder();
    const endpoint = createSafeHandler(
      {
        ...baseConfig,
        realtime: workspaceResourceSetUpdates(RESOURCE_TYPE.ENTITY),
      },
      async function* () {
        return yield* Result.err(
          new HandlerError({ status: 409, message: "Duplicate value" }),
        );
      },
      { announce },
    );

    const result = await endpoint.handler(asTestRaw(requestContext()));

    expect(result).toMatchObject({ code: 409 });
    expect(announcements).toEqual([]);
  });

  test("a database failure (rolled-back transaction) announces nothing", async () => {
    const { announcements, announce } = recorder();
    const endpoint = createSafeHandler(
      {
        ...baseConfig,
        realtime: workspaceResourceSetUpdates(RESOURCE_TYPE.ENTITY),
      },
      async function* () {
        return yield* Result.err(
          new DatabaseError({ message: "transaction rolled back" }),
        );
      },
      { announce },
    );

    const result = await endpoint.handler(asTestRaw(requestContext()));

    expect(result).toMatchObject({ code: 500 });
    expect(announcements).toEqual([]);
  });

  test("a handler that throws announces nothing", async () => {
    const { announcements, announce } = recorder();
    const endpoint = createSafeHandler(
      {
        ...baseConfig,
        realtime: workspaceResourceSetUpdates(RESOURCE_TYPE.ENTITY),
      },
      async function* () {
        const crash = (): { ok: true } => {
          throw new Error("handler crashed after its write");
        };
        return Result.ok(crash());
      },
      { announce },
    );

    const result = await endpoint.handler(asTestRaw(requestContext()));

    expect(result).toMatchObject({ code: 500 });
    expect(announcements).toEqual([]);
  });

  test("a caller refused before the handler runs announces nothing", async () => {
    const { announcements, announce } = recorder();
    let ran = false;
    const endpoint = createSafeHandler(
      {
        ...baseConfig,
        realtime: workspaceResourceSetUpdates(RESOURCE_TYPE.ENTITY),
      },
      async function* () {
        ran = true;
        return Result.ok({ ok: true });
      },
      { announce },
    );

    const result = await endpoint.handler(
      asTestRaw(requestContext({ withMemberRole: false })),
    );

    expect(result).toMatchObject({ code: 403 });
    expect(ran).toBe(false);
    expect(announcements).toEqual([]);
  });

  test("a success status announces; an error status or failed response does not", async () => {
    const outcomes = [
      { value: status(201, { id: "created" }), announced: true },
      { value: new Response("ok", { status: 200 }), announced: true },
      { value: new Response("gone", { status: 410 }), announced: false },
    ] as const;
    for (const outcome of outcomes) {
      const { announcements, announce } = recorder();
      const endpoint = createSafeHandler(
        {
          ...baseConfig,
          realtime: workspaceResourceSetUpdates(RESOURCE_TYPE.ENTITY),
        },
        async function* () {
          return Result.ok(outcome.value);
        },
        { announce },
      );

      await endpoint.handler(asTestRaw(requestContext()));

      expect(announcements.length).toBe(outcome.announced ? 1 : 0);
    }
  });

  test("a handler without a declaration, or declaring none, announces nothing", async () => {
    for (const realtime of [
      undefined,
      noResourceSetUpdates("broadcasts its own per-resource events"),
    ]) {
      const { announcements, announce } = recorder();
      const endpoint = createSafeHandler(
        { ...baseConfig, ...(realtime === undefined ? {} : { realtime }) },
        async function* () {
          return Result.ok({ ok: true });
        },
        { announce },
      );

      expect(await endpoint.handler(asTestRaw(requestContext()))).toEqual({
        ok: true,
      });
      expect(announcements).toEqual([]);
    }
  });
});

describe("an organization handler's declared resource sets", () => {
  test("a success announces to the caller's organization", async () => {
    const { announcements, announce } = recorder();
    const endpoint = createSafeRootHandler(
      {
        ...baseConfig,
        realtime: organizationResourceSetUpdates(RESOURCE_TYPE.AGENT_SKILL),
      },
      async function* () {
        return Result.ok({ ok: true });
      },
      { announce },
    );

    await endpoint.handler(asTestRaw(requestContext()));

    expect(announcements).toEqual([
      {
        audience: "organization",
        id: ORGANIZATION_ID,
        type: RESOURCE_TYPE.AGENT_SKILL,
      },
    ]);
  });

  test("a root handler cannot declare a matter-scoped set", () => {
    createSafeRootHandler(
      {
        ...baseConfig,
        // @ts-expect-error -- a root handler has no validated matter to announce to
        realtime: workspaceResourceSetUpdates(RESOURCE_TYPE.ENTITY),
      },
      async function* () {
        return Result.ok({ ok: true });
      },
    );
  });
});

describe("announceResourceSetUpdates", () => {
  test("a matter-scoped set without a matter has no audience", () => {
    const { announcements, announce } = recorder();
    announce({
      realtime: workspaceResourceSetUpdates(RESOURCE_TYPE.ENTITY),
      result: { ok: true },
      organizationId: ORGANIZATION_ID,
      workspaceId: undefined,
    });
    expect(announcements).toEqual([]);
  });
});
