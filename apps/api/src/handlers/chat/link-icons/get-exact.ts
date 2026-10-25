import { Result } from "better-result";
import * as v from "valibot";

import { getLinkIconCache } from "@/api/handlers/chat/link-icons/cache";
import {
  createExactIconOrigin,
  ICON_URL_MAX_LENGTH,
  toExactIconUrl,
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
        "Decorative icons use a bundled fallback when bytes are unavailable.",
    },
  },
  query: v.object({
    url: v.pipe(v.string(), v.maxLength(ICON_URL_MAX_LENGTH)),
  }),
} satisfies HandlerConfig;

const readOrigin = createExactIconOrigin();

// This root read uses authenticated identity and fetches only validated public bytes;
// it neither reads nor writes tenant data.
export const createGetExactIconHandler = (readCache = getLinkIconCache) =>
  createSafeRootHandler(
    config,
    async function* ({ query: { url }, user, request, set }) {
      const target = toExactIconUrl(url);
      if (target === null) {
        return Result.ok(linkIconBody({ type: "no-icon" }, set));
      }
      const outcome = yield* Result.ok(
        await readLinkIcon({
          hostname: target,
          userId: user.id,
          ip: resolveClientIp(request, null) ?? "unresolved",
          cache: readCache(),
          readOrigin: async (exact) =>
            await readOrigin(exact.value, grantThirdPartyOutboundPermit()),
        }),
      );
      return Result.ok(linkIconBody(outcome, set));
    },
  );

export default createGetExactIconHandler();
