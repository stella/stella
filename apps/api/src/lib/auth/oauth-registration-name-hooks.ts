import { APIError, createAuthMiddleware } from "better-auth/api";

import { isRecord } from "../type-guards";
import {
  CLI_CLIENT_DISPLAY_NAME,
  LEGACY_CLI_CLIENT_NAME,
  mayRegisterClientName,
} from "./cli-client-registration";

/** Better Auth consumes registration refusals as APIError at this hook boundary. */
export const createOAuthRegistrationNameHook = () =>
  createAuthMiddleware(async ({ body }) => {
    if (!isRecord(body)) {
      return;
    }
    if (!mayRegisterClientName(body)) {
      throw new APIError("BAD_REQUEST", {
        error: "invalid_client_metadata",
        message: "This client name is reserved. Choose another name.",
      });
    }
    if (body["client_name"] === LEGACY_CLI_CLIENT_NAME) {
      // Released CLIs retain their request contract while new rows use the display name.
      return {
        context: { body: { ...body, client_name: CLI_CLIENT_DISPLAY_NAME } },
      };
    }
  });
