import { Result } from "better-result";
import Elysia, { t } from "elysia";

import {
  printPdfHandler,
  readFileHandler,
  stampedDownloadHandler,
} from "@/api/handlers/files/read-by-id";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { workspaceAccessMacro } from "@/api/lib/auth";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";

const readFileEndpoint = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    query: t.Object({
      purpose: t.UnionEnum(["download", "display", "native-display"]),
    }),
    params: workspaceParams({ fieldId: tSafeId("field") }),
  } satisfies HandlerConfig,
  async function* ({
    params: { fieldId },
    query: { purpose },
    scopedDb,
    session,
    workspaceId,
  }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readFileHandler({
            fieldId,
            organizationId: session.activeOrganizationId,
            workspaceId,
            purpose,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const printPdfEndpoint = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    params: workspaceParams({ fieldId: tSafeId("field") }),
  } satisfies HandlerConfig,
  async function* ({ params: { fieldId }, scopedDb, session, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await printPdfHandler({
            fieldId,
            organizationId: session.activeOrganizationId,
            workspaceId,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const stampedDownloadEndpoint = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    params: workspaceParams({ fieldId: tSafeId("field") }),
  } satisfies HandlerConfig,
  async function* ({ params: { fieldId }, scopedDb, session, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await stampedDownloadHandler({
            fieldId,
            organizationId: session.activeOrganizationId,
            workspaceId,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

export const filesRoute = new Elysia({
  prefix: "/files/:workspaceId",
})
  .use(workspaceAccessMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .get("/url/:fieldId", readFileEndpoint.handler, {
    query: readFileEndpoint.config.query,
    params: readFileEndpoint.config.params,
  })
  .get("/print-pdf/:fieldId", printPdfEndpoint.handler, {
    params: printPdfEndpoint.config.params,
  })
  .get("/stamped/:fieldId", stampedDownloadEndpoint.handler, {
    params: stampedDownloadEndpoint.config.params,
  });
