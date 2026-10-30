import { APIError, createAuthMiddleware } from "better-auth/api";

import { isRecord } from "../type-guards";
import { mayRegisterClientName } from "./cli-client-registration";

/** Better Auth consumes registration refusals as APIError at this hook boundary. */
export const createOAuthRegistrationNameHook = () =>
  createAuthMiddleware(async ({ body }) => {
    if (isRecord(body) && !mayRegisterClientName(body)) {
      throw new APIError("BAD_REQUEST", {
        error: "invalid_client_metadata",
        message: "This client name is reserved. Choose another name.",
      });
    }
  });
