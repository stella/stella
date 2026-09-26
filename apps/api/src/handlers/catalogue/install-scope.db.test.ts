import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import { createSafeDb } from "@/api/db/scoped";
import createSkill from "@/api/handlers/skills/create";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import installBundledSkill from "./install";

/**
 * Installing a catalogue skill for oneself is private skill creation, so it
 * needs what authoring or importing a private skill needs. A team install
 * still needs an owner or admin.
 */

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

// No catalogue entry carries this slug, so an install that gets past every
// access check ends at the catalogue lookup with a 404.
const UNKNOWN_SLUG = "no-such-catalogue-skill";

const installAsMember = async (scope: "private" | "team") => {
  const result = await installBundledSkill.handler(
    createTestHandlerContext<Parameters<typeof installBundledSkill.handler>[0]>(
      {
        memberRole: { role: "member" },
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
        safeDb: asTestRaw<SafeDb>(
          createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
        ),
        body: { slug: UNKNOWN_SLUG, scope },
      },
    ),
  );
  if (!("code" in result)) {
    throw new TypeError("expected the unknown slug to be refused");
  }
  return result.code;
};

describe("catalogue skill install scope", () => {
  test("needs the same permission as creating a private skill", () => {
    expect(installBundledSkill.config.permissions).toEqual(
      createSkill.config.permissions,
    );
  });

  test("a member's private install passes every access check", async () => {
    expect(await installAsMember("private")).toBe(404);
  });

  test("a member's team install is refused", async () => {
    expect(await installAsMember("team")).toBe(403);
  });
});
