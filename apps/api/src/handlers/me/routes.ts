import acceptProfessionalUse from "@/api/handlers/me/accept-professional-use";
import disconnectOAuthConnection from "@/api/handlers/me/disconnect-oauth-connection";
import listOAuthConnections from "@/api/handlers/me/list-oauth-connections";
import deleteAccountPendingTasks from "@/api/handlers/me/pending-tasks";
import readProfessionalUse from "@/api/handlers/me/professional-use";
import deleteAccountSendOtp from "@/api/handlers/me/send-otp";
import twoFactorSendManageOtp from "@/api/handlers/me/two-factor-send-manage-otp";
import updateGuideProgress from "@/api/handlers/me/update-guide-progress";
import deleteAccountVerify from "@/api/handlers/me/verify-delete";
import { mount, routes } from "@/api/http/route";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";

const isDeleteAccountOtpSendPath = (pathname: string): boolean =>
  pathname === "/v1/me/delete/send-otp";

const isTwoFactorManageOtpSendPath = (pathname: string): boolean =>
  pathname === "/v1/me/two-factor/send-otp";

export const meRoute = mount(
  [
    routes({
      "/oauth-connections": { GET: listOAuthConnections },
      "/guide-progress": { PATCH: updateGuideProgress },
      "/professional-use": {
        GET: readProfessionalUse,
        POST: acceptProfessionalUse,
      },
      "/oauth-connections/:consentId": { DELETE: disconnectOAuthConnection },
    }),
    mount([
      routes(
        {
          "/pending-tasks": { GET: deleteAccountPendingTasks },
        },
        { prefix: "/delete" },
      ),
      routes(
        {
          "/send-otp": { POST: deleteAccountSendOtp },
          "/verify": { POST: deleteAccountVerify },
        },
        {
          prefix: "/delete",
          middleware: [
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
              skip: (req) =>
                !isDeleteAccountOtpSendPath(new URL(req.url).pathname),
            }),
          ],
        },
      ),
    ]),
    routes(
      {
        "/send-otp": { POST: twoFactorSendManageOtp },
      },
      {
        prefix: "/two-factor",
        middleware: [
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
        ],
      },
    ),
  ],
  { prefix: "/me" },
);
