import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  // Any org member needs to know whether translation is usable;
  // the answer is a single boolean. Anything that exposes the key
  // (even masked) lives behind organizationSettings:update — see
  // read-deepl-config.
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

/**
 * Report whether the org has a DeepL key configured. Returns no
 * details about the key itself; the settings card uses a separate
 * admin-scoped endpoint for the masked preview + tier.
 */
const readDeepLAvailability = createSafeRootHandler(
  config,
  async function* ({ safeDb, session }) {
    const row = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: {
            organizationId: { eq: session.activeOrganizationId },
          },
          columns: {
            deeplApiKeyEncrypted: true,
            deeplApiKeyIv: true,
          },
        }),
      ),
    );

    return Result.ok({
      configured: Boolean(row?.deeplApiKeyEncrypted && row.deeplApiKeyIv),
    });
  },
);

export default readDeepLAvailability;
