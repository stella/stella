import { describe, expect, test } from "bun:test";

import ownership from "../../scripts/ownership/dedicated-database-connections.ts";
import initialization from "../../scripts/ownership/maintenance-session-initialization.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

describe("dedicated connection ownership", () => {
  const source = [
    'import { createDedicatedConnectionOwner as create } from "@/api/db/dedicated-connection-slots";',
    'import * as slots from "@/api/db/dedicated-connection-slots";',
    'const { createDedicatedConnectionSlots } = await import("@/api/db/dedicated-connection-slots");',
    'export * from "@/api/db/dedicated-connection-slots";',
  ].join("\n");

  test("rejects alternate entrypoints to the process owner", async () => {
    expect(
      await lintSingleRule("confine-owner", source, {
        ruleOptions: { entries: [ownership] },
        sourcePath: "apps/api/src/lib/unowned-connection.ts",
      }),
    ).toEqual([1, 2, 3, 4]);
  });

  test("admits the owner and each lifecycle consumer", async () => {
    for (const sourcePath of [
      ...ownership.owner,
      ...ownership.enforcement.allowed.map(({ path }) => path),
    ]) {
      expect(
        await lintSingleRule("confine-owner", source, {
          ruleOptions: { entries: [ownership] },
          sourcePath,
        }),
      ).toEqual([]);
    }
  });
});

test("session initialization cannot become an alternate operator entrypoint", async () => {
  const source = [
    'import {createMaintenanceLaneSession} from "@/api/lib/case-law/maintenance-lane";',
    'import {enterCaseLawMaintenanceLane} from "@/api/lib/case-law/maintenance-lane";',
  ].join("\n");
  expect(
    await lintSingleRule("confine-owner", source, {
      ruleOptions: { entries: [initialization] },
      sourcePath: "apps/api/src/scripts/operator.ts",
    }),
  ).toEqual([1]);
  expect(
    await lintSingleRule("confine-owner", source, {
      ruleOptions: { entries: [initialization] },
      sourcePath: initialization.enforcement.allowed[0].path,
    }),
  ).toEqual([]);
});
