import Elysia from "elysia";
import { rateLimit } from "elysia-rate-limit";

import deleteAccountPendingTasks from "@/api/handlers/me/pending-tasks";
import deleteAccountSendOtp from "@/api/handlers/me/send-otp";
import deleteAccountVerify from "@/api/handlers/me/verify-delete";
import { sessionAuthMacro } from "@/api/lib/auth";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import {
  InMemoryRateLimitContext,
  scopedGenerator,
} from "@/api/lib/rate-limit";

const isDeleteAccountOtpSendPath = (pathname: string): boolean =>
  pathname === "/v1/me/delete/send-otp";

export const meRoute = new Elysia({ prefix: "/me" })
  .use(sessionAuthMacro)
  .guard({ validateSession: true })
  .group("/delete", (app) =>
    app
      .get("/pending-tasks", deleteAccountPendingTasks.handler)
      .use(
        rateLimit({
          scoping: "scoped",
          duration: API_RATE_LIMITS.deleteAccountOtp.duration,
          max: API_RATE_LIMITS.deleteAccountOtp.max,
          generator: scopedGenerator("delete-account-otp"),
          context: new InMemoryRateLimitContext(),
          skip: (req) =>
            !isDeleteAccountOtpSendPath(new URL(req.url).pathname),
        }),
      )
      .post("/send-otp", deleteAccountSendOtp.handler)
      .post("/verify", deleteAccountVerify.handler, {
        body: deleteAccountVerify.config.body,
      }),
  );
