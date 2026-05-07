import { Result } from "better-result";
import { t } from "elysia";

import { probeMcpServer } from "@/api/handlers/mcp-connectors/probe";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const requestBody = t.Object({
  url: t.String({ minLength: 1, maxLength: 2048 }),
});

const config = {
  permissions: { organizationSettings: ["update"] },
  body: requestBody,
} satisfies HandlerConfig;

const probeMcpConnector = createSafeRootHandler(
  config,
  async function* ({ body: input }) {
    const probe = yield* Result.await(
      probeMcpServer(input.url).then((result) => {
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
      }),
    );

    return Result.ok(probe);
  },
);

export default probeMcpConnector;
