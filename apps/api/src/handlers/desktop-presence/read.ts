import { Result } from "better-result";

import { desktopPresenceSchema } from "@stll/api-contract/desktop-presence";

import {
  ACCOUNT_ACCESS,
  createSafeRootHandler,
  safeHandlerResponseSchemas,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

import { readDesktopPresence } from "./service";

const config = {
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "native_tool_ui" },
  access: "read",
  response: safeHandlerResponseSchemas(desktopPresenceSchema),
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ scopedDb, user, session }) {
    const presence = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readDesktopPresence({
            scopedDb,
            userId: user.id,
            organizationId: session.activeOrganizationId,
          }),
      ),
    );
    return Result.ok(presence);
  },
);
