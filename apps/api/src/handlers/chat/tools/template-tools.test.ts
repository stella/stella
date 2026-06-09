import { describe, expect, test } from "bun:test";

import type { ScopedDb } from "@/api/db";
import { toSafeId } from "@/api/lib/branded-types";

import {
  createTemplateTools,
  DESCRIBE_TEMPLATE_TOOL_NAME,
  FILL_TEMPLATE_TOOL_NAME,
  LIST_TEMPLATES_TOOL_NAME,
} from "./template-tools.js";

type TemplateRow = { id: string; name: string; fieldCount: number };

const orgId = toSafeId<"organization">("org-test");

/** Minimal scopedDb stub exposing only the templates RQB list_templates calls. */
const stubScopedDb = (rows: TemplateRow[]): ScopedDb => {
  const tx = { query: { templates: { findMany: async () => rows } } };
  // SAFETY: test double — exposes only the surface list_templates touches.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  return (async (run: (t: typeof tx) => unknown) =>
    await run(tx)) as unknown as ScopedDb;
};

describe("createTemplateTools", () => {
  test("registers list, describe and fill template tools", () => {
    const tools = createTemplateTools({
      scopedDb: stubScopedDb([]),
      organizationId: orgId,
    });
    expect(tools[LIST_TEMPLATES_TOOL_NAME]).toBeDefined();
    expect(tools[DESCRIBE_TEMPLATE_TOOL_NAME]).toBeDefined();
    expect(tools[FILL_TEMPLATE_TOOL_NAME]).toBeDefined();
  });

  test("list_templates returns the workspace's templates", async () => {
    const rows: TemplateRow[] = [
      { id: "t1", name: "NDA", fieldCount: 4 },
      { id: "t2", name: "Power of Attorney", fieldCount: 7 },
    ];
    const tools = createTemplateTools({
      scopedDb: stubScopedDb(rows),
      organizationId: orgId,
    });
    // SAFETY: invoke the tool's execute directly with a stub call context.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion
    const execute = tools[LIST_TEMPLATES_TOOL_NAME].execute as unknown as (
      input: unknown,
      options: unknown,
    ) => Promise<{ templates: TemplateRow[] }>;

    const result = await execute({}, {});
    expect(result).toEqual({ templates: rows });
  });
});
