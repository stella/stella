import { Result } from "better-result";

import {
  ACCOUNT_ACCESS,
  createSafeSessionHandler,
} from "@/api/lib/api-handlers";
import type { SessionHandlerConfig } from "@/api/lib/api-handlers";
import { sendManageOtp } from "@/api/lib/auth/confirmation-email";
import { getUserEmailAndTwoFactorEnabled } from "@/api/lib/two-factor";

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "account_lifecycle" },
} satisfies SessionHandlerConfig;

export default createSafeSessionHandler(config, async function* (ctx) {
  const currentUserId = ctx.user.id;
  const request = ctx.request;

  // 1. Fetch the address the code goes to. Every two-factor transition is
  // gated on this code, enrollment included, so the current enablement
  // state does not decide whether a code may be requested.
  const { email: emailStr } = yield* Result.await(
    getUserEmailAndTwoFactorEnabled(currentUserId),
  );

  const sent = yield* Result.await(
    sendManageOtp({
      purpose: "two-factor-manage",
      email: emailStr,
      request,
    }),
  );
  return Result.ok(sent);
});
