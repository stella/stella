import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { MACHINE_API_KEY_PREFIX } from "@/api/lib/machine-api-key-config";
import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
} from "@/api/lib/security-headers";
import {
  KEY_SELF_INSPECTION,
  resolveMachineApiKeyCredential,
} from "@/api/mcp/api-key-auth";
import { McpAuthenticationError } from "@/api/mcp/errors";

/** Self-only expiry inspection; never opens a browser session or lists keys. */
export const createCurrentMachineApiKeyHandler = (
  resolveCredential: typeof resolveMachineApiKeyCredential = resolveMachineApiKeyCredential,
) =>
  createSafeTokenHandler(
    {
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "auth_plumbing" },
    },
    async function* ({ request, set }) {
      set.headers[CACHE_CONTROL_HEADER] = PRIVATE_CACHE_CONTROL;
      const authorization = request.headers.get("authorization");
      if (
        !authorization?.startsWith(`Bearer ${MACHINE_API_KEY_PREFIX}`) ||
        authorization.length > 256
      ) {
        return Result.err(
          new HandlerError({
            status: 401,
            message: "Invalid or expired API key",
          }),
        );
      }
      const credential = yield* Result.await(
        Result.tryPromise({
          try: async () =>
            await resolveCredential(authorization.slice(7), {
              mode: KEY_SELF_INSPECTION,
            }),
          catch: (cause) =>
            new HandlerError({
              status: cause instanceof McpAuthenticationError ? 401 : 503,
              message: "Could not inspect API key expiry",
              cause,
            }),
        }),
      );
      return Result.ok({ expiresAt: credential.expiresAt });
    },
  );

export default createCurrentMachineApiKeyHandler();
