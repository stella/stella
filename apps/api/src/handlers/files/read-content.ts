import { Result } from "better-result";

import { Temporal } from "@stll/time";

import { env } from "@/api/env";
import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { checkFileContentGrant } from "@/api/lib/files/file-content-grant";
import { readFileContentHandler } from "@/api/lib/files/read-file";
import { permissiveRouteSchema } from "@/api/lib/permissive-route-schema";
import type { TokenScopedDatabase } from "@/api/lib/root-scoped-db";
import { tokenScopedDatabase } from "@/api/lib/root-scoped-db";

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  contentDelivery: {
    type: "public",
    reason:
      "Redeems a short-lived HMAC-bound grant that was audited when issued and rechecks version liveness before reading storage.",
  },
  mcp: { type: "internal", reason: "upload_mechanics" },
  params: permissiveRouteSchema({ keys: ["grant"] }),
} satisfies TokenHandlerConfig;

type ReadFileContentDependencies = {
  database?: TokenScopedDatabase;
  now?: () => number;
};

export const createReadFileContentEndpoint = ({
  database = tokenScopedDatabase,
  now = () => Temporal.Now.instant().epochMilliseconds,
}: ReadFileContentDependencies = {}) =>
  createSafeTokenHandler(config, async function* ({ params, request }) {
    const checked = checkFileContentGrant({
      grant: params.grant ?? "",
      now: now(),
      secret: env.BETTER_AUTH_SECRET,
    });
    if (checked.status !== "valid") {
      return Result.err(
        new HandlerError({ status: 404, message: "File grant not found." }),
      );
    }

    const { grant } = checked;
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readFileContentHandler({
            abortSignal: request.signal,
            fieldId: grant.fieldId,
            organizationId: grant.organizationId,
            purpose: grant.purpose,
            scopedDb: database.scoped({
              organizationId: grant.organizationId,
              userId: grant.userId,
              workspaceIds: [grant.workspaceId],
            }),
            workspaceId: grant.workspaceId,
          }),
      ),
    );
    return Result.ok(response);
  });

export const readFileContentEndpoint = createReadFileContentEndpoint();
