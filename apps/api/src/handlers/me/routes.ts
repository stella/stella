import Elysia from "elysia";
import { rateLimit } from "elysia-rate-limit";

import deleteAccountSendOtp from "@/api/handlers/me/send-otp";
import deleteAccountVerify from "@/api/handlers/me/verify-delete";
import { sessionAuthMacro } from "@/api/lib/auth";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import {
  InMemoryRateLimitContext,
  scopedGenerator,
} from "@/api/lib/rate-limit";

export const meRoute = new Elysia({ prefix: "/me" })
  .use(sessionAuthMacro)
  .guard({ validateSession: true })
  .group("/delete", (app) =>
    app
      .use(
        rateLimit({
          scoping: "scoped",
          duration: API_RATE_LIMITS.deleteAccountOtp.duration,
          max: API_RATE_LIMITS.deleteAccountOtp.max,
          generator: scopedGenerator("delete-account-otp"),
          context: new InMemoryRateLimitContext(),
        }),
      )
      .post("/send-otp", deleteAccountSendOtp.handler)
      .post("/verify", deleteAccountVerify.handler, {
        body: deleteAccountVerify.config.body,
      }),
  );
