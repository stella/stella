import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { listSkillMetadata } from "@stll/skills";

import { skillHandlerContext } from "@/api/tests/helpers/agent-skill-db";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import listSkills from "./list";

type ListContext = Parameters<typeof listSkills.handler>[0];

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  await releaseRlsFixture();
});

describe("listing skills", () => {
  test("returns every shipped built-in skill beside the installed page", async () => {
    const result = await listSkills.handler(
      skillHandlerContext<ListContext>({
        testDb,
        organizationId: ids.orgB,
        userId: ids.userB1,
        query: {},
      }),
    );
    if (!("builtIn" in result)) {
      throw new Error("expected the skills list to succeed");
    }

    expect(result.builtIn.map(({ slug }) => slug)).toEqual(
      listSkillMetadata().map(({ name }) => name),
    );
    for (const skill of result.builtIn) {
      expect(skill).toMatchObject({
        enabled: true,
        id: skill.slug,
        origin: "built-in",
        scope: "built-in",
      });
    }
    expect(result.builtIn.length).toBeGreaterThan(0);
  });
});
