import Elysia from "elysia";

import deleteAccountSendOtp from "@/api/handlers/me/send-otp";
import deleteAccountVerify from "@/api/handlers/me/verify-delete";
import { sessionAuthMacro } from "@/api/lib/auth";

export const meRoute = new Elysia({ prefix: "/me" })
  .use(sessionAuthMacro)
  .guard({ validateSession: true })
  .post("/delete/send-otp", deleteAccountSendOtp.handler)
  .post("/delete/verify", deleteAccountVerify.handler, {
    body: deleteAccountVerify.config.body,
  });
