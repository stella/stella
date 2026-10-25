import { Result } from "better-result";

import { CACHE_CONTROL_HEADER, PRIVATE_CACHE_CONTROL } from "@/api/http/cache";
import type { VerifyCaller } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { MACHINE_API_KEY_PREFIX } from "@/api/lib/machine-api-key-config";
import { resolveOwnMachineApiKeyCredential } from "@/api/mcp/api-key-auth";
import { McpAuthenticationError } from "@/api/mcp/errors";

type MachineApiKeyCredential = Awaited<
  ReturnType<typeof resolveOwnMachineApiKeyCredential>
>;

/** The caller is the machine API key in its bearer header, and only that key. */
const verifyMachineApiKeyCaller =
  (
    resolveCredential: typeof resolveOwnMachineApiKeyCredential,
  ): VerifyCaller<MachineApiKeyCredential> =>
  async ({ request }) => {
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
    return await Result.tryPromise({
      try: async () => await resolveCredential(authorization.slice(7)),
      catch: (cause) =>
        new HandlerError({
          status: cause instanceof McpAuthenticationError ? 401 : 503,
          message: "Could not inspect API key expiry",
          cause,
        }),
    });
  };

/** Self-only expiry inspection; never opens a browser session or lists keys. */
export const createCurrentMachineApiKeyHandler = (
  resolveCredential: typeof resolveOwnMachineApiKeyCredential = resolveOwnMachineApiKeyCredential,
) =>
  createSafeTokenHandler(
    {
      contract: "patch",
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "auth_plumbing" },
    },
    verifyMachineApiKeyCaller(resolveCredential),
    // oxlint-disable-next-line typescript/require-await -- safe handlers must remain async generators for Result.gen error capture.
    async function* ({ caller, set }) {
      set.headers[CACHE_CONTROL_HEADER] = PRIVATE_CACHE_CONTROL;
      const credential = yield* Result.ok(caller);
      return Result.ok({ expiresAt: credential.expiresAt });
    },
  );

export default createCurrentMachineApiKeyHandler();
