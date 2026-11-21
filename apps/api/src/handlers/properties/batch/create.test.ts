import { describe, expect, test } from "bun:test";

import type { ApiRoutePath } from "@/api/http/api-route-types";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createScopedDbMock,
  createSelectQueryMock,
} from "@/api/tests/scoped-db-mock";

import createPropertiesBatch from "./create";

type Context = Parameters<typeof createPropertiesBatch.handler>[0];

describe("createPropertiesBatch", () => {
  test("refuses an implicit AI input when the batch adds another file column", async () => {
    const systemFileId = toSafeId<"property">("system_file");
    const { safeDb, scopedDb } = createScopedDbMock({
      select: () =>
        createSelectQueryMock([
          {
            id: systemFileId,
            name: "Documents",
            content: { version: 1, type: "file" },
            tool: { version: 1, type: "manual-input" },
            role: null,
          },
        ]),
    });

    const result = await createPropertiesBatch.handler(
      asTestRaw<Context>({
        body: {
          items: [
            {
              name: "Other files",
              contentType: "file",
              toolType: "manual-input",
            },
            {
              name: "Summary",
              contentType: "text",
              toolType: "ai-model",
              prompt: "Summarize the document",
            },
          ],
        },
        request: new Request("https://example.test/v1/properties/batch"),
        route: "/v1/properties/:workspaceId/batch" satisfies ApiRoutePath,
        safeDb,
        scopedDb,
        workspaceId: toSafeId<"workspace">("workspace_test"),
        memberRole: sessionMemberRole("owner"),
        session: {
          activeOrganizationId: toSafeId<"organization">("org_test"),
        },
        user: { id: toSafeId<"user">("user_test") },
        recordAuditEvent: async () => {},
      }),
    );

    expect(result).toMatchObject({
      code: 422,
      response: {
        code: "ai-column-input-required",
        hint: expect.stringContaining(systemFileId),
      },
    });
  });
});
