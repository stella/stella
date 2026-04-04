import Elysia, { t } from "elysia";

import { generateAnalysis } from "@/api/handlers/case-law/analysis/generate";
import {
  listDecisionsHandler,
  listDecisionsQuerySchema,
} from "@/api/handlers/case-law/decisions/list";
import { readDecisionHandler } from "@/api/handlers/case-law/decisions/read-by-id";
import {
  searchDecisionsBodySchema,
  searchDecisionsHandler,
} from "@/api/handlers/case-law/decisions/search";
import { getIngestionStatus } from "@/api/handlers/case-law/ingestion/status";
import {
  createMatterLinkBodySchema,
  createMatterLinkHandler,
} from "@/api/handlers/case-law/matter-links/create";
import { deleteMatterLinkHandler } from "@/api/handlers/case-law/matter-links/delete";
import { listMatterLinksHandler } from "@/api/handlers/case-law/matter-links/list";
import {
  ADMIN_BYPASS_ROLES,
  authMacro,
  permissionMacro,
  workspaceAccessMacro,
} from "@/api/lib/auth";
import { tNanoid } from "@/api/lib/custom-schema";

/**
 * Global-read routes: any authenticated user can read.
 * No organizationId filtering; decisions are public records.
 */
const globalCaseLawRoute = new Elysia({
  prefix: "/case",
})
  .use(authMacro)
  .guard({ validateAuth: true })
  .get(
    "/decisions",
    async (ctx) => await listDecisionsHandler(ctx.query, ctx.scopedDb),
    {
      query: listDecisionsQuerySchema,
    },
  )
  .get(
    "/decisions/:decisionId",
    async (ctx) =>
      await readDecisionHandler(ctx.params.decisionId, ctx.scopedDb),
    { params: t.Object({ decisionId: tNanoid }) },
  )
  .post(
    "/decisions/search",
    async (ctx) => await searchDecisionsHandler(ctx.body, ctx.scopedDb),
    {
      body: searchDecisionsBodySchema,
    },
  )
  .get(
    "/decisions/:decisionId/analysis",
    async (ctx) =>
      await generateAnalysis(ctx.params.decisionId, ctx.scopedDb),
    { params: t.Object({ decisionId: tNanoid }) },
  )
  .get(
    "/decisions/:decisionId/analysis/debug",
    async (ctx) => {
      const { decisionId } = ctx.params;
      const decision = await ctx.scopedDb((tx) =>
        tx.query.caseLawDecisions.findFirst({
          where: { id: decisionId },
          columns: {
            id: true,
            language: true,
            court: true,
            country: true,
            decisionType: true,
            documentAst: true,
          },
        }),
      );
      if (!decision) {
        return { error: "not found" };
      }

      const { getSystemPrompt } = await import(
        "@/api/handlers/case-law/analysis/prompts/index"
      );
      const { formatDecisionForPrompt } = await import(
        "@/api/handlers/case-law/analysis/prompts/base"
      );
      const { hasUsableAst } = await import(
        "@/api/handlers/case-law/document-ast"
      );
      const { getModelForRole } = await import("@/api/lib/ai-models");

      const model = getModelForRole("fast");
      const modelId =
        typeof model === "string"
          ? model
          : "modelId" in model
            ? String(model.modelId)
            : "unknown";

      const systemPrompt = getSystemPrompt(decision.language);
      const ast = hasUsableAst(decision.documentAst)
        ? (decision.documentAst as { blocks: { anchorId: string; plainText: string; type: string }[] })
        : null;

      const userMessage = ast
        ? `Court: ${decision.court}\nCountry: ${decision.country}\nType: ${decision.decisionType ?? "unknown"}\n\n${formatDecisionForPrompt(ast.blocks)}`
        : null;

      return {
        model: modelId,
        systemPromptLength: systemPrompt.length,
        systemPrompt,
        userMessageLength: userMessage?.length ?? 0,
        userMessage,
      };
    },
    { params: t.Object({ decisionId: tNanoid }) },
  );

/**
 * Workspace-scoped routes: requires workspace access.
 * Links decisions (global) to matters (workspace-scoped).
 */
const caseLawMatterLinksRoute = new Elysia({
  prefix: "/case/matter-links/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({ validateWorkspaceAccess: true })
  .get(
    "/",
    async (ctx) =>
      await listMatterLinksHandler({
        workspaceId: ctx.workspaceId,
        scopedDb: ctx.scopedDb,
      }),
  )
  .post(
    "/",
    async (ctx) =>
      await createMatterLinkHandler({
        workspaceId: ctx.workspaceId,
        userId: ctx.user.id,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { entity: ["create"] },
      body: createMatterLinkBodySchema,
    },
  )
  .delete(
    "/:linkId",
    async (ctx) =>
      await deleteMatterLinkHandler({
        workspaceId: ctx.workspaceId,
        linkId: ctx.params.linkId,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { entity: ["delete"] },
      params: t.Object({ workspaceId: tNanoid, linkId: tNanoid }),
    },
  );

/**
 * Admin routes: authenticated + admin/owner role.
 * Ingestion observability for operators.
 */
const caseLawAdminRoute = new Elysia({
  prefix: "/case/admin",
})
  .use(authMacro)
  .guard({ validateAuth: true })
  .onBeforeHandle(({ memberRole, set }) => {
    if (!ADMIN_BYPASS_ROLES.includes(memberRole.role)) {
      set.status = 403;
      return { error: "Forbidden" } as const;
    }
    return;
  })
  .get("/ingestion/status",  async (ctx) => getIngestionStatus(ctx.scopedDb));

export const caseLawRoute = new Elysia()
  .use(globalCaseLawRoute)
  .use(caseLawMatterLinksRoute)
  .use(caseLawAdminRoute);
