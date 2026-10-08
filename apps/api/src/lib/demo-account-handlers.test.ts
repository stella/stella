import { describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import { readFileEndpoint } from "@/api/handlers/files/routes";
import deleteAccountVerify from "@/api/handlers/me/verify-delete";
import createWorkspace from "@/api/handlers/workspaces/create";
import addWorkspaceMember from "@/api/handlers/workspaces/members/add";
import removeWorkspaceMember from "@/api/handlers/workspaces/members/remove";
import updateWorkspace from "@/api/handlers/workspaces/update";
import { createFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/policy";
import { toSafeId } from "@/api/lib/branded-types";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";

describe("account lifecycle handlers", () => {
  test.each([undefined, "org_account"])(
    "checks account eligibility before membership or account changes with binding %s",
    async (binding) => {
      const previous = {
        email: env.DEMO_ACCOUNT_EMAIL,
        organizationId: env.DEMO_ACCOUNT_ORGANIZATION_ID,
      };
      env.DEMO_ACCOUNT_EMAIL = "account@example.test";
      env.DEMO_ACCOUNT_ORGANIZATION_ID = binding;
      const user = {
        id: toSafeId<"user">("user_account"),
        email: "account@example.test",
      };
      try {
        const downloaded = await readFileEndpoint.handler(
          createTestHandlerContext<
            Parameters<typeof readFileEndpoint.handler>[0]
          >({
            user,
            params: {
              workspaceId: "workspace_account",
              fieldId: "field_account",
            },
            query: { purpose: "download" },
          }),
        );
        const added = await addWorkspaceMember.handler(
          createTestHandlerContext<
            Parameters<typeof addWorkspaceMember.handler>[0]
          >({ user, body: { userId: "user_other" } }),
        );
        const removed = await removeWorkspaceMember.handler(
          createTestHandlerContext<
            Parameters<typeof removeWorkspaceMember.handler>[0]
          >({
            user,
            params: { workspaceId: "workspace_account", userId: "user_other" },
          }),
        );
        const created = await createWorkspace.handler(
          createTestHandlerContext<
            Parameters<typeof createWorkspace.handler>[0]
          >({
            user,
            session: {
              activeOrganizationId: toSafeId<"organization">("org_account"),
            },
            featureAccessSnapshot: createFeatureAccessSnapshot({
              organizationId: "org_account",
              userId: user.id,
              decisions: new Map(),
            }),
            body: {
              id: toSafeId<"workspace">("workspace_account"),
              clientId: toSafeId<"contact">("contact_account"),
              memberUserIds: ["user_member"],
              name: "Matter",
              filePropertyName: "Documents",
            },
          }),
        );
        const updated = await updateWorkspace.handler(
          createTestHandlerContext<
            Parameters<typeof updateWorkspace.handler>[0]
          >({
            user,
            body: {
              promote: {
                clientId: toSafeId<"contact">("contact_account"),
                memberUserIds: ["user_member"],
              },
            },
          }),
        );
        const deleted = await deleteAccountVerify.handler(
          createTestHandlerContext<
            Parameters<typeof deleteAccountVerify.handler>[0]
          >({ user, body: { code: "123456" } }),
        );
        for (const response of [
          downloaded,
          added,
          removed,
          created,
          updated,
          deleted,
        ]) {
          expect(response).toMatchObject({
            code: 403,
            response: { code: "account_access_unavailable" },
          });
        }
      } finally {
        env.DEMO_ACCOUNT_EMAIL = previous.email;
        env.DEMO_ACCOUNT_ORGANIZATION_ID = previous.organizationId;
      }
    },
  );
});
