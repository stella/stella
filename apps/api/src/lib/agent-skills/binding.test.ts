import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import {
  NO_SKILL_BINDING_SCOPE,
  resolveSkillBindingScope,
  skillBindingAllows,
  UNBOUND,
} from "@/api/lib/agent-skills/binding";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const matterA = toSafeId<"workspace">("0199a1b2-0000-7000-8000-00000000000a");
const matterB = toSafeId<"workspace">("0199a1b2-0000-7000-8000-00000000000b");
const clientX = toSafeId<"contact">("0199a1b2-0000-7000-8000-0000000000c1");
const clientY = toSafeId<"contact">("0199a1b2-0000-7000-8000-0000000000c2");

/** A database where the caller reads exactly these matters. */
const readableMatters = (
  rows: { clientId: SafeId<"contact"> | null; id: SafeId<"workspace"> }[],
): SafeDb =>
  asTestRaw<SafeDb>(async (run: (tx: unknown) => Promise<unknown>) =>
    Result.ok(
      await run({
        select: () => ({
          from: () => ({
            where: () => ({ limit: async () => rows }),
          }),
        }),
      }),
    ),
  );

const scopeOf = async (
  homeWorkspaceId: SafeId<"workspace"> | null,
  otherWorkspaceIds: SafeId<"workspace">[],
  rows: { clientId: SafeId<"contact"> | null; id: SafeId<"workspace"> }[],
) => {
  const scope = await resolveSkillBindingScope({
    homeWorkspaceId,
    otherWorkspaceIds,
    safeDb: readableMatters(rows),
  });
  if (Result.isError(scope)) {
    throw scope.error;
  }
  return scope.value;
};

const boundTo = {
  clientX: { boundClientId: clientX, boundWorkspaceId: null },
  matterA: { boundClientId: null, boundWorkspaceId: matterA },
};

describe("resolveSkillBindingScope", () => {
  test("a global conversation allows unbound skills only", async () => {
    const scope = await scopeOf(null, [matterA], []);
    expect(skillBindingAllows(scope, UNBOUND)).toBe(true);
    expect(skillBindingAllows(scope, boundTo.matterA)).toBe(false);
    expect(skillBindingAllows(scope, boundTo.clientX)).toBe(false);
  });

  test("a conversation in one matter allows its matter and its client", async () => {
    const scope = await scopeOf(
      matterA,
      [matterA],
      [{ clientId: clientX, id: matterA }],
    );
    expect(skillBindingAllows(scope, boundTo.matterA)).toBe(true);
    expect(skillBindingAllows(scope, boundTo.clientX)).toBe(true);
    expect(
      skillBindingAllows(scope, {
        boundClientId: clientY,
        boundWorkspaceId: null,
      }),
    ).toBe(false);
  });

  test("another matter of the same client keeps the client binding, not the matter one", async () => {
    const scope = await scopeOf(
      matterA,
      [matterB],
      [
        { clientId: clientX, id: matterA },
        { clientId: clientX, id: matterB },
      ],
    );
    expect(skillBindingAllows(scope, boundTo.matterA)).toBe(false);
    expect(skillBindingAllows(scope, boundTo.clientX)).toBe(true);
  });

  test("a matter of another client breaks both bindings", async () => {
    const scope = await scopeOf(
      matterA,
      [matterB],
      [
        { clientId: clientX, id: matterA },
        { clientId: clientY, id: matterB },
      ],
    );
    expect(skillBindingAllows(scope, boundTo.matterA)).toBe(false);
    expect(skillBindingAllows(scope, boundTo.clientX)).toBe(false);
    expect(skillBindingAllows(scope, UNBOUND)).toBe(true);
  });

  test("a home matter the caller cannot read allows unbound skills only", async () => {
    const scope = await scopeOf(matterA, [], []);
    expect(skillBindingAllows(scope, boundTo.matterA)).toBe(false);
    expect(skillBindingAllows(scope, boundTo.clientX)).toBe(false);
    expect(skillBindingAllows(scope, UNBOUND)).toBe(true);
  });

  test("a personal matter (no client) allows no client binding", async () => {
    const scope = await scopeOf(matterA, [], [{ clientId: null, id: matterA }]);
    expect(skillBindingAllows(scope, boundTo.matterA)).toBe(true);
    expect(skillBindingAllows(scope, boundTo.clientX)).toBe(false);
  });
});

describe("NO_SKILL_BINDING_SCOPE", () => {
  test("allows unbound skills only", () => {
    expect(skillBindingAllows(NO_SKILL_BINDING_SCOPE, UNBOUND)).toBe(true);
    expect(skillBindingAllows(NO_SKILL_BINDING_SCOPE, boundTo.matterA)).toBe(
      false,
    );
    expect(skillBindingAllows(NO_SKILL_BINDING_SCOPE, boundTo.clientX)).toBe(
      false,
    );
  });
});
