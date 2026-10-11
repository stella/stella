import { describe, expect, test } from "bun:test";

import { caseLawRoute } from "@/api/handlers/case-law/routes";
import { legalResolveRoute } from "@/api/handlers/legal-resolve/routes";
import { legislationCorpusRoute } from "@/api/handlers/legislation/corpus-routes";
import { legislationRoute } from "@/api/handlers/legislation/routes";
import {
  isAdmittedLawReadHandler,
  isSafePublicHandler,
} from "@/api/lib/api-handlers";
import { isAdmittedMcpLawReadHandler } from "@/api/mcp/law-read-admission";
import { LEGAL_RESOLVE_RESOURCE_ROUTES } from "@/api/mcp/resource-policy-contract";
import {
  getStaticMcpToolHandler,
  listStaticMcpToolDefinitions,
} from "@/api/mcp/static-tool-definitions";

const organizationRecordRoutes = new Set([
  "GET /case/admin/ingestion/status",
  "GET /case/matter-links/:workspaceId/",
  "POST /case/matter-links/:workspaceId/",
  "POST /case/matter-links/:workspaceId/batch",
  "DELETE /case/matter-links/:workspaceId/:linkId",
  "GET /case/research/columns",
  "POST /case/research/columns",
  "PUT /case/research/columns/order",
  "PATCH /case/research/columns/:columnId",
  "DELETE /case/research/columns/:columnId",
  "POST /case/research/answers/lookup",
]);

describe("organization public-law content admission", () => {
  test("every authenticated corpus route has the admission binding", () => {
    const routes = [
      ...caseLawRoute.routes,
      ...legislationRoute.routes,
      ...legislationCorpusRoute.routes,
    ].filter((route) => typeof route.handler === "function");
    const lawReads = routes.filter(
      (route) =>
        !isSafePublicHandler(route.handler) &&
        !organizationRecordRoutes.has(`${route.method} ${route.path}`),
    );
    expect(lawReads.length).toBeGreaterThan(0);
    expect(
      lawReads
        .filter((route) => !isAdmittedLawReadHandler(route.handler))
        .map((route) => `${route.method} ${route.path}`),
    ).toEqual([]);
    expect(
      routes
        .filter((route) => isSafePublicHandler(route.handler))
        .every((route) => !isAdmittedLawReadHandler(route.handler)),
    ).toBe(true);
  });

  test("organization listings keep admission at the hydrated-content boundary", async () => {
    for (const file of [
      "handlers/case-law/matter-links/list.ts",
      "handlers/chat/threads/list.ts",
    ]) {
      const source = await Bun.file(
        new URL(`../../${file}`, import.meta.url),
      ).text();
      expect(source).toContain("admission: LawReadAdmission");
      expect(source).toMatch(/\b(?:admit|admitLawRead)\(\{\s*organizationId/u);
      expect(source).toContain('type: "refused"');
      expect(source).not.toContain("createSafeLawReadRootHandler");
    }
  });

  test("every registered public-law MCP read has the admission binding in each audience", () => {
    for (const audience of [
      "default",
      "law",
      "advanced",
      "anonymized",
      "documents",
    ] as const) {
      const tools = listStaticMcpToolDefinitions(audience).filter(
        (tool) => tool.feature === "FEATURE_PUBLIC_LAW",
      );
      for (const tool of tools) {
        expect(
          isAdmittedMcpLawReadHandler(
            getStaticMcpToolHandler(tool.name, audience),
          ),
          `${audience}:${tool.name} requires admission`,
        ).toBe(true);
      }
    }
  });

  test("token resolver routes retain their own admitted read boundary", async () => {
    expect(
      legalResolveRoute.routes
        .map(({ method, path }) => `${method} ${path}`)
        .toSorted(),
    ).toEqual(
      Object.values(LEGAL_RESOLVE_RESOURCE_ROUTES)
        .map(({ path }) => `GET ${path}`)
        .toSorted(),
    );
    const source = await Bun.file(
      new URL("../../handlers/legal-resolve/authorization.ts", import.meta.url),
    ).text();
    expect(source).toMatch(/await admitLawRead\(\{\s*organizationId,/u);
    expect(source).toContain("admission: admission.value");
    for (const file of ["decision-endpoint.ts", "law-endpoint.ts"]) {
      const endpoint = await Bun.file(
        new URL(`../../handlers/legal-resolve/${file}`, import.meta.url),
      ).text();
      expect(endpoint).toContain("admission: prepared.authorization.admission");
    }
  });

  test("mixed MCP reads admit only their corpus payload while annotations list organization records", async () => {
    const compat = await Bun.file(
      new URL("../../mcp/compat-tools.ts", import.meta.url),
    ).text();
    expect(compat).toMatch(/await admitMcpLawRead\(context\)/u);
    expect(compat).toContain("admission: lawRead.admission");
    expect(compat).toContain("corpusOutcome:");
    expect(compat).toContain('status: "refused"');
    const annotation = await Bun.file(
      new URL("../../mcp/reader-annotation-tools.ts", import.meta.url),
    ).text();
    expect(annotation).toMatch(/\badmission:\s*lawRead\.admission/u);
    const list = annotation.slice(
      annotation.indexOf("const handleListTool"),
      annotation.indexOf("const handleCreateTool"),
    );
    expect(list).toContain("listReaderAnnotationsHandler");
    expect(list).not.toContain("resolveTargetForAgent");
  });

  test("attached chat law content requires admission before either reader", async () => {
    const source = await Bun.file(
      new URL("../../handlers/chat/chat-prompt.ts", import.meta.url),
    ).text();
    expect(source).toMatch(/\badmitLawRead\(\{\s*organizationId/u);
    for (const reader of [
      "ActiveDecisionSectionProps",
      "ActiveStatuteSectionProps",
    ]) {
      const start = source.indexOf(`type ${reader} = {`);
      expect(start).toBeGreaterThan(-1);
      const signature = source.slice(start, source.indexOf("};", start));
      expect(signature).toContain("admission: LawReadAdmission");
      expect(signature).not.toContain("organizationId:");
    }
    expect(source).toMatch(/buildActiveDecisionSection\(\{[^}]*\badmission,/u);
    expect(source).toMatch(/buildActiveStatuteSection\(\{[^}]*\badmission,/u);
  });
});
