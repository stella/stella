import { Result } from "better-result";
import * as v from "valibot";

import { probeMcpServer } from "@/api/handlers/mcp-connectors/probe";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const requestBody = v.object({
  url: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
});

const config = {
  contract: "patch",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "mcp_transport" },
  body: requestBody,
} satisfies HandlerConfig;

const probeMcpConnector = createSafeRootHandler(
  config,
  async function* ({ body: input }) {
    const probe = yield* Result.await(
      probeMcpServer(input.url, grantThirdPartyOutboundPermit()).then(
        (result) => {
          if (Result.isError(result)) {
            return Result.err(
              new HandlerError({
                status: 400,
                message: result.error.message,
                cause: result.error,
              }),
            );
          }

          return Result.ok(result.value);
        },
      ),
    );

    return Result.ok(probe);
  },
);

export default probeMcpConnector;
