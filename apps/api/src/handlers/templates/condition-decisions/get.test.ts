import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { env } from "@/api/env";
import {
  ORG_AI_CONFIG_STATUS,
  type OrgAIConfigStatus,
} from "@/api/lib/ai-config-loader-core";
import { authorizeHandlerUsage } from "@/api/lib/api-handlers";
import { toSafeId } from "@/api/lib/branded-types";
import { ActionAdmissionError } from "@/api/lib/rate-limit/action-admission";
import type {
  createModelActionAdmitter,
  ModelActionAdmitter,
} from "@/api/lib/rate-limit/model-action-admission";
import type {
  decideTemplateConditions,
  TemplateConditionDecisions,
} from "@/api/lib/templates/template-decide-conditions";
import {
  createTestHandlerContext,
  NO_AUDIT,
} from "@/api/tests/helpers/handler-context";
import { testModelActionAdmitter } from "@/api/tests/helpers/model-dispatch-admission";
import { createTestState } from "@/api/tests/helpers/test-state";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { createConditionPreviewHandler } from "./get";

const testState = createTestState({ file: import.meta.path, config: env });
const fields = [
  {
    path: "is_consumer",
    inputType: "boolean",
    aiPrompt: "Is this a consumer contract?",
  },
];

beforeEach(() => {
  testState.setConfig("USAGE_ENFORCEMENT_ENABLED", false);
});

const previewFixture = ({
  manifestFields = fields,
  refusal,
}: {
  manifestFields?: typeof fields;
  refusal?: "busy" | "store_unavailable";
} = {}) => {
  const { scopedDb, safeDb } = createScopedDbMock({
    query: {
      templates: {
        findFirst: async () => ({
          manifest: { fields: manifestFields, clauseSlots: [] },
        }),
      },
    },
  });
  const authorizeUsage = mock(authorizeHandlerUsage);
  const createAdmitter = mock(
    ({ organizationId }: Parameters<typeof createModelActionAdmitter>[0]) => {
      if (refusal === undefined) {
        return testModelActionAdmitter(organizationId, "templates.fill");
      }
      const refuse: ModelActionAdmitter = async () =>
        Result.err(
          new ActionAdmissionError({
            reason: refusal,
            message: "Model action refused",
          }),
        );
      return refuse;
    },
  );
  const decideConditions = mock(
    async (
      _input: Parameters<typeof decideTemplateConditions>[0],
    ): Promise<TemplateConditionDecisions> => ({
      conditions: [],
      model: "test-generator",
    }),
  );
  const handler = createConditionPreviewHandler({
    authorizeUsage,
    createAdmitter,
    decideConditions,
  });
  const run = async (
    values: Record<string, unknown>,
    orgAIConfigStatus: OrgAIConfigStatus = ORG_AI_CONFIG_STATUS.ok,
  ) =>
    await handler.handler(
      createTestHandlerContext<Parameters<typeof handler.handler>[0]>({
        scopedDb,
        safeDb,
        audit: NO_AUDIT,
        params: { templateId: toSafeId<"template">("tmpl_preview") },
        body: { values },
        orgAIConfigStatus,
      }),
    );
  return { run, authorizeUsage, createAdmitter, decideConditions, safeDb };
};

describe("condition preview conditional AI gates", () => {
  test.each(["empty", "supplied"] as const)(
    "%s conditions enter no usage or admission gate",
    async (mode) => {
      const fixture = previewFixture({
        manifestFields: mode === "empty" ? [] : fields,
        refusal: "busy",
      });
      const result = await fixture.run(
        { is_consumer: false },
        ORG_AI_CONFIG_STATUS.memberAssignmentRequired,
      );
      expect(result).toMatchObject({ conditions: expect.any(Array) });
      expect(fixture.authorizeUsage).not.toHaveBeenCalled();
      expect(fixture.createAdmitter).not.toHaveBeenCalled();
      expect(fixture.decideConditions).not.toHaveBeenCalled();
    },
  );

  test("open conditions authorize and admit the actual decision runtime", async () => {
    const fixture = previewFixture();
    const result = await fixture.run({});
    expect(result).toMatchObject({ conditions: expect.any(Array) });
    expect(fixture.authorizeUsage).toHaveBeenCalledTimes(1);
    expect(fixture.createAdmitter).toHaveBeenCalledTimes(1);
    expect(fixture.decideConditions).toHaveBeenCalledTimes(1);
    expect(fixture.decideConditions.mock.calls.at(0)?.at(0)).toMatchObject({
      generation: {
        dataClass: "customer",
        managedAIResidency: "eu",
        organizationId: "org_test",
        admission: expect.anything(),
      },
      skillContext: {
        organizationId: "org_test",
        userId: "user_test",
        safeDb: fixture.safeDb,
      },
      usageMetering: {
        organizationId: "org_test",
        userId: "user_test",
        actionType: "chat",
      },
    });
  });

  test.each([
    { reason: "busy", status: 429 },
    { reason: "store_unavailable", status: 503 },
  ] as const)(
    "open conditions preserve admission $status",
    async ({ reason, status }) => {
      const fixture = previewFixture({ refusal: reason });
      const result = await fixture.run({});
      expect(result).toMatchObject({
        code: status,
        response: {
          code:
            reason === "busy"
              ? "action_concurrency_busy"
              : "limiter_store_unavailable",
        },
      });
      expect(fixture.authorizeUsage).toHaveBeenCalledTimes(1);
      expect(fixture.createAdmitter).toHaveBeenCalledTimes(1);
      expect(fixture.decideConditions).not.toHaveBeenCalled();
    },
  );
});
