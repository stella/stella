import { panic, Result } from "better-result";
import { t } from "elysia";

import { getLinkIconCache } from "@/api/handlers/chat/link-icons/cache";
import {
  createLinkIconOrigin,
  isCanonicalIconHostname,
} from "@/api/handlers/chat/link-icons/origin";
import { linkIconResponse } from "@/api/handlers/chat/link-icons/response";
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
  // oxlint-disable-next-line require-yield -- safe handlers use generators for Result error capture.
  async function* ({ params: { hostname }, user, request }) {
    if (!isCanonicalIconHostname(hostname)) {
      return Result.ok(linkIconResponse(null));
    }
    const cache = getLinkIconCache();
    const cached = await cache.readOrLease({
      hostname,
      userId: user.id,
      ip: resolveClientIp(request, null) ?? "unresolved",
    });
    switch (cached.type) {
      case "hit":
        return Result.ok(linkIconResponse(cached.icon));
      case "no-icon":
        return Result.ok(linkIconResponse(null));
      case "lease": {
        const fetched = await readOrigin(
          hostname,
          grantThirdPartyOutboundPermit(),
        );
        // Capacity does not establish that this host has no icon. Let its short
        // lease expire instead of keeping a negative entry for an hour.
        if (fetched.type === "capacity") {
          return Result.ok(linkIconResponse(null));
        }
        const icon = fetched.type === "icon" ? fetched.icon : null;
        const stored = await cache.store({
          hostname,
          token: cached.token,
          icon,
        });
        return Result.ok(linkIconResponse(stored ? icon : null));
      }
      default: {
        cached satisfies never;
        return panic("Unhandled link icon cache state");
      }
    }
  },
);

export default getLinkIcon;
