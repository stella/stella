import Elysia from "elysia";

import acceptProfessionalUse from "@/api/handlers/me/accept-professional-use";
import disconnectOAuthConnection from "@/api/handlers/me/disconnect-oauth-connection";
import listOAuthConnections from "@/api/handlers/me/list-oauth-connections";
import deleteAccountPendingTasks from "@/api/handlers/me/pending-tasks";
import readProfessionalUse from "@/api/handlers/me/professional-use";
import deleteAccountSendOtp from "@/api/handlers/me/send-otp";
import twoFactorSendManageOtp from "@/api/handlers/me/two-factor-send-manage-otp";
import updateGuideProgress from "@/api/handlers/me/update-guide-progress";
import deleteAccountVerify from "@/api/handlers/me/verify-delete";
import { sessionAuthMacro } from "@/api/lib/auth";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";

const isDeleteAccountOtpSendPath = (pathname: string): boolean =>
  pathname === "/v1/me/delete/send-otp";

const isTwoFactorManageOtpSendPath = (pathname: string): boolean =>
  pathname === "/v1/me/two-factor/send-otp";

export const meRoute = new Elysia({ prefix: "/me" })
  .use(sessionAuthMacro)
  .guard({ validateSession: true })
  .get("/oauth-connections", listOAuthConnections.handler, {
    accountAccess: listOAuthConnections.config.accountAccess,
  })
  .patch("/guide-progress", updateGuideProgress.handler, {
    accountAccess: updateGuideProgress.config.accountAccess,
    body: updateGuideProgress.config.body,
  })
  .get("/professional-use", readProfessionalUse.handler, {
    accountAccess: readProfessionalUse.config.accountAccess,
  })
  .post("/professional-use", acceptProfessionalUse.handler, {
    accountAccess: acceptProfessionalUse.config.accountAccess,
    body: acceptProfessionalUse.config.body,
  })
  .delete("/oauth-connections/:consentId", disconnectOAuthConnection.handler, {
    accountAccess: disconnectOAuthConnection.config.accountAccess,
    params: disconnectOAuthConnection.config.params,
  })
  .group("/delete", (app) =>
    app
      .get("/pending-tasks", deleteAccountPendingTasks.handler, {
        accountAccess: deleteAccountPendingTasks.config.accountAccess,
      })
      .use(
        rateLimit({
          duration: API_RATE_LIMITS.deleteAccountOtp.duration,
          max: API_RATE_LIMITS.deleteAccountOtp.max,
          budget: {
            name: "api.delete_account_otp.address",
            keyKind: "address",
          },
          ...createRedisRateLimit({
            failurePolicy: "fail_open_local",
            scope: "delete-account-otp",
          }),
          skip: (req) => !isDeleteAccountOtpSendPath(new URL(req.url).pathname),
        }),
      )
      .post("/send-otp", deleteAccountSendOtp.handler, {
        accountAccess: deleteAccountSendOtp.config.accountAccess,
      })
      .post("/verify", deleteAccountVerify.handler, {
        accountAccess: deleteAccountVerify.config.accountAccess,
        body: deleteAccountVerify.config.body,
      }),
  )
  .group("/two-factor", (app) =>
    app
      .use(
        rateLimit({
          duration: API_RATE_LIMITS.twoFactorManageOtp.duration,
          max: API_RATE_LIMITS.twoFactorManageOtp.max,
          budget: {
            name: "api.two_factor_manage_otp.address",
            keyKind: "address",
          },
          ...createRedisRateLimit({
            failurePolicy: "fail_open_local",
            scope: "two-factor-manage-otp",
          }),
          skip: (req) =>
            !isTwoFactorManageOtpSendPath(new URL(req.url).pathname),
        }),
      )
      .post("/send-otp", twoFactorSendManageOtp.handler, {
        accountAccess: twoFactorSendManageOtp.config.accountAccess,
      }),
  );
