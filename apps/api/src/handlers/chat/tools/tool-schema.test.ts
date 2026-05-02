import { describe, expect, test } from "bun:test";

import type { ScopedDb } from "@/api/db";
import { createChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import { toSafeId } from "@/api/lib/branded-types";

import { createOrgTools } from "./org-tools";
import { createSkillTools } from "./skill-tools";
import {
  buildCreatedDocumentToolOutput,
  createWorkspaceTools,
} from "./workspace-tools";

const organizationId = toSafeId<"organization">(
  "11111111-1111-4111-8111-111111111111",
);
const userId = toSafeId<"user">("22222222-2222-4222-8222-222222222222");
const workspaceId = toSafeId<"workspace">(
  "33333333-3333-4333-8333-333333333333",
);
const entityId = toSafeId<"entity">("44444444-4444-4444-8444-444444444444");

const unusedScopedDb: ScopedDb = async () => {
  throw new Error("This test only constructs tool schemas.");
};

describe("chat tool schemas", () => {
  test("construct org-level tools as JSON-schema-compatible AI tools", () => {
    expect(() =>
      createOrgTools({
        accessibleWorkspaceIds: [workspaceId],
        organizationId,
        scopedDb: unusedScopedDb,
      }),
    ).not.toThrow();
  });

  test("construct workspace tools as JSON-schema-compatible AI tools", () => {
    expect(() =>
      createWorkspaceTools({
        allowedWorkspaceIds: [workspaceId],
        organizationId,
        refRegistry: createChatRefRegistry(),
        scopedDb: unusedScopedDb,
        userId,
      }),
    ).not.toThrow();
  });

  test("construct skill tools as JSON-schema-compatible AI tools", () => {
    expect(() =>
      createSkillTools({
        skills: [
          {
            description: "Analyze legal texts.",
            name: "legal-interpretation",
            version: "3.0",
          },
        ],
      }),
    ).not.toThrow();
  });

  test("created document output includes the canonical entity mention", () => {
    const refRegistry = createChatRefRegistry();

    expect(
      buildCreatedDocumentToolOutput({
        entityId,
        fileName: "Mzuri_Umowa_Strona_1.docx",
        refRegistry,
        workspaceId,
      }),
    ).toEqual({
      success: true,
      fileName: "Mzuri_Umowa_Strona_1.docx",
      entityRef: "ent_1",
      matterRef: "mat_1",
      href: "#stella-entity-ref=ent_1",
      mention: "[Mzuri_Umowa_Strona_1.docx](#stella-entity-ref=ent_1)",
    });
  });
});
