import { Result } from "better-result";
import { t } from "elysia";

import { getLinkIconCache } from "@/api/handlers/chat/link-icons/cache";
import {
  createLinkIconOrigin,
  toRegistrableIconSite,
} from "@/api/handlers/chat/link-icons/origin";
import { readLinkIcon } from "@/api/handlers/chat/link-icons/read";
import { linkIconBody } from "@/api/handlers/chat/link-icons/response";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { resolveClientIp } from "@/api/lib/client-ip";

const config = {
  contract: "patch",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "chat_thread_ui" },
  transport: {
    type: "file-response",
    response: { mediaTypes: ["image/png", "image/x-icon", "application/json"] },
    alternative: {
      type: "none",
      reason:
        "Decorative icons are optional; use the bundled globe when image bytes are unavailable.",
    },
  },
  params: t.Object({ hostname: t.String({ maxLength: 253 }) }),
} satisfies HandlerConfig;

const readOrigin = createLinkIconOrigin();

// This root read uses only authenticated identity and public hostname bytes;
// it neither reads nor writes tenant data.
const getLinkIcon = createSafeRootHandler(
  config,
  async function* ({ params: { hostname }, user, request, set }) {
    const site = toRegistrableIconSite(hostname);
    if (Result.isError(site)) {
      return Result.ok(linkIconBody({ type: "no-icon" }, set));
    }
    const outcome = yield* Result.ok(
      await readLinkIcon({
        hostname: site.value,
        userId: user.id,
        ip: resolveClientIp(request, null) ?? "unresolved",
        cache: getLinkIconCache(),
        readOrigin: async (host) =>
          await readOrigin(host, grantThirdPartyOutboundPermit()),
      }),
    );
    return Result.ok(linkIconBody(outcome, set));
  },
);

export default getLinkIcon;
