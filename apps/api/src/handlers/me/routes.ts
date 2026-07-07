import Elysia from "elysia";
import { rateLimit } from "elysia-rate-limit";

import disconnectOAuthConnection from "@/api/handlers/me/disconnect-oauth-connection";
import listOAuthConnections from "@/api/handlers/me/list-oauth-connections";
import deleteAccountPendingTasks from "@/api/handlers/me/pending-tasks";
import deleteAccountSendOtp from "@/api/handlers/me/send-otp";
import twoFactorSendManageOtp from "@/api/handlers/me/two-factor-send-manage-otp";
import deleteAccountVerify from "@/api/handlers/me/verify-delete";
import { sessionAuthMacro } from "@/api/lib/auth";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";

const isDeleteAccountOtpSendPath = (pathname: string): boolean =>
  pathname === "/v1/me/delete/send-otp";

const isTwoFactorManageOtpSendPath = (pathname: string): boolean =>
  pathname === "/v1/me/two-factor/send-otp";

export const meRoute = new Elysia({ prefix: "/me" })
  .use(sessionAuthMacro)
  .guard({ validateSession: true })
  .get("/oauth-connections", listOAuthConnections.handler)
  .delete("/oauth-connections/:consentId", disconnectOAuthConnection.handler, {
    params: disconnectOAuthConnection.config.params,
  })
  .group("/delete", (app) =>
    app
      .get("/pending-tasks", deleteAccountPendingTasks.handler)
      .use(
        rateLimit({
          scoping: "scoped",
          duration: API_RATE_LIMITS.deleteAccountOtp.duration,
          max: API_RATE_LIMITS.deleteAccountOtp.max,
          ...createRedisRateLimit({
            failurePolicy: "fail_open_local",
            scope: "delete-account-otp",
          }),
          skip: (req) => !isDeleteAccountOtpSendPath(new URL(req.url).pathname),
        }),
      )
      .post("/send-otp", deleteAccountSendOtp.handler)
      .post("/verify", deleteAccountVerify.handler, {
        body: deleteAccountVerify.config.body,
      }),
  )
  .group("/two-factor", (app) =>
    app
      .use(
        rateLimit({
          scoping: "scoped",
          duration: API_RATE_LIMITS.twoFactorManageOtp.duration,
          max: API_RATE_LIMITS.twoFactorManageOtp.max,
          generator: scopedGenerator("two-factor-manage-otp"),
          context: new InMemoryRateLimitContext(),
          skip: (req) =>
            !isTwoFactorManageOtpSendPath(new URL(req.url).pathname),
        }),
      )
      .post("/send-otp", twoFactorSendManageOtp.handler),
  );
