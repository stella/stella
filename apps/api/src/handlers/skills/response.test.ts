import { expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import { toAgentSkillResponse } from "./response";

test("a skill response retains its invocation and binding", () => {
  const boundClientId = toSafeId<"contact">(Bun.randomUUIDv7());
  const response = toAgentSkillResponse(
    {
      id: toSafeId<"agentSkill">(Bun.randomUUIDv7()),
      scope: "private",
      origin: "authored",
      userId: "skill-author",
      slug: "review-document",
      name: "Review document",
      description: "Review the selected document.",
      version: null,
      license: null,
      compatibility: null,
      sourceUrl: null,
      contentHash: "0".repeat(64),
      enabled: true,
      invocation: "manual",
      body: "Review the selected document.",
      command: "review-document",
      boundClientId,
      boundWorkspaceId: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
    [],
  );

  expect(response.invocation).toBe("manual");
  expect(response.boundClientId).toBe(boundClientId);
  expect(response.boundWorkspaceId).toBeNull();
});
