import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { readSsoConnection } from "@/api/lib/sso-connections";

const config = {
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "internal", reason: "provider_secret" },
} satisfies HandlerConfig;

const read = createSafeRootHandler(config, async function* ({ session }) {
  const connection = yield* Result.await(
    readSsoConnection(session.activeOrganizationId),
  );
  return Result.ok({ connection });
});

export default read;
