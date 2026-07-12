import { describe, expect, test } from "bun:test";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { toSafeId } from "@/api/lib/branded-types";

import {
  createTemplateAuthoringTools,
  createTemplateTools,
  DESCRIBE_TEMPLATE_TOOL_NAME,
  FILL_TEMPLATE_TOOL_NAME,
  LIST_TEMPLATES_TOOL_NAME,
  SUGGEST_TEMPLATE_FIELDS_TOOL_NAME,
} from "./template-tools.js";

type TemplateRow = { id: string; name: string; fieldCount: number };

const orgId = toSafeId<"organization">("org-test");
const userId = toSafeId<"user">("user-test");

/** Minimal scopedDb stub exposing only the templates RQB list_templates calls. */
const stubScopedDb = (
  rows: TemplateRow[],
  onFindMany?: (options: unknown) => void,
): ScopedDb => {
  const tx = {
    query: {
      templates: {
        findMany: async (options: unknown) => {
          onFindMany?.(options);
          return rows;
        },
      },
    },
  };
  // SAFETY: test double — exposes only the surface list_templates touches.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  return (async (run: (t: typeof tx) => unknown) =>
    await run(tx)) as unknown as ScopedDb;
};

/** safeDb stub: the metering callbacks only touch it on a model step, which
 *  these tool-registration tests never trigger (no orgAIConfig), so it is
 *  never invoked. */
// SAFETY: test double — never called because no AI generation runs here.
// eslint-disable-next-line typescript/no-unsafe-type-assertion
const stubSafeDb = (() => {
  throw new Error("safeDb stub must not be called");
}) as unknown as SafeDb;

describe("createTemplateTools", () => {
  test("registers list, describe and fill template tools", () => {
    const tools = createTemplateTools({
      orgAIConfig: null,
      scopedDb: stubScopedDb([]),
      safeDb: stubSafeDb,
      organizationId: orgId,
      userId,
    });
    expect(tools[LIST_TEMPLATES_TOOL_NAME]).toBeDefined();
    expect(tools[DESCRIBE_TEMPLATE_TOOL_NAME]).toBeDefined();
    expect(tools[FILL_TEMPLATE_TOOL_NAME]).toBeDefined();
  });

  // The use-gated factory must not leak the authoring tool: a fill-only role
  // (intern: template `use` without `create`) registers these tools, so
  // `suggest_template_fields` belongs to `createTemplateAuthoringTools` instead.
  test("does not register the authoring-only suggest tool", () => {
    const tools = createTemplateTools({
      orgAIConfig: null,
      scopedDb: stubScopedDb([]),
      safeDb: stubSafeDb,
      organizationId: orgId,
      userId,
    });
    expect(SUGGEST_TEMPLATE_FIELDS_TOOL_NAME in tools).toBe(false);
  });

  test("list_templates explicitly scopes the organization query", async () => {
    const rows: TemplateRow[] = [
      { id: "t1", name: "NDA", fieldCount: 4 },
      { id: "t2", name: "Power of Attorney", fieldCount: 7 },
    ];
    let findManyOptions: unknown;
    const tools = createTemplateTools({
      orgAIConfig: null,
      scopedDb: stubScopedDb(rows, (options) => {
        findManyOptions = options;
      }),
      safeDb: stubSafeDb,
      organizationId: orgId,
      userId,
    });
    // SAFETY: invoke the tool's execute directly with a stub call context.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion
    const execute = tools[LIST_TEMPLATES_TOOL_NAME].execute as unknown as (
      input: unknown,
      options: unknown,
    ) => Promise<{ templates: TemplateRow[] }>;

    const result = await execute({}, {});
    expect(result).toEqual({ templates: rows });
    expect(findManyOptions).toMatchObject({
      where: { organizationId: { eq: orgId } },
    });
  });
});

describe("createTemplateAuthoringTools", () => {
  test("registers the suggest-fields authoring tool", () => {
    const tools = createTemplateAuthoringTools({
      orgAIConfig: null,
      safeDb: stubSafeDb,
      organizationId: orgId,
      userId,
    });
    expect(tools[SUGGEST_TEMPLATE_FIELDS_TOOL_NAME]).toBeDefined();
  });
});
