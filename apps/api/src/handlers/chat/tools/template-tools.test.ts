import { describe, expect, test } from "bun:test";

import type { ScopedDb } from "@/api/db";

import {
  createTemplateTools,
  LIST_TEMPLATES_TOOL_NAME,
} from "./template-tools.js";

type TemplateRow = { id: string; name: string; fieldCount: number };

/** Minimal scopedDb stub exposing only the templates RQB the tool calls. */
const stubScopedDb = (rows: TemplateRow[]): ScopedDb => {
  const tx = { query: { templates: { findMany: async () => rows } } };
  // SAFETY: test double — exposes only the surface list_templates touches.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  return ((run: (t: typeof tx) => unknown) =>
    Promise.resolve(run(tx))) as unknown as ScopedDb;
};

describe("createTemplateTools", () => {
  test("registers the list_templates tool with no required inputs", () => {
    const tools = createTemplateTools({ scopedDb: stubScopedDb([]) });
    const listTool = tools[LIST_TEMPLATES_TOOL_NAME];
    expect(listTool).toBeDefined();
    expect(typeof listTool.description).toBe("string");
  });

  test("list_templates returns the workspace's templates", async () => {
    const rows: TemplateRow[] = [
      { id: "t1", name: "NDA", fieldCount: 4 },
      { id: "t2", name: "Power of Attorney", fieldCount: 7 },
    ];
    const tools = createTemplateTools({ scopedDb: stubScopedDb(rows) });
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
