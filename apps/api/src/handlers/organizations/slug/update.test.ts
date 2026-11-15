import { expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";

import updateSlug from "./update";

test("agent runs cannot change an organization slug even with an owner's permissions", async () => {
  const session = {
    activeOrganizationId: toSafeId<"organization">("org_agent_slug_test"),
    credentialType: "agent_run",
  };
  const result = await updateSlug.handler(
    createTestHandlerContext<Parameters<typeof updateSlug.handler>[0]>({
      body: { type: "opaque" },
      session,
      audit: NO_AUDIT,
      safeDb: NO_DB,
      scopedDb: NO_DB,
    }),
  );
  expect(result).toMatchObject({
    code: 403,
    response: { code: "agent_run_refused" },
  });
});
