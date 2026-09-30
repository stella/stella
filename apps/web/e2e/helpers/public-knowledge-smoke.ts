import { expect, test } from "@playwright/test";
import { panic } from "better-result";
import * as v from "valibot";

import { loadCatalogue } from "@stll/catalogue";

import messages from "../../src/i18n/langs/en.json" with { type: "json" };
import { createNetworkCollector } from "./network";

const PACK_ID = "general-legal";
const PUBLIC_API = "/api/v1/public/knowledge/template-packs";
const templateSchema = v.object({ id: v.string(), title: v.string() });
type CatalogueTemplate = v.InferOutput<typeof templateSchema>;
type VisitorRoute = {
  template: string;
  resolve: (template: CatalogueTemplate) => {
    path: string;
    heading: string;
    level: 1 | 2;
  };
};
const tool =
  loadCatalogue().find(({ slug }) => slug === "contract-review") ??
  panic("smoke catalogue entry missing");

export const PUBLIC_VISITOR_ROUTE_DEFS = [
  {
    template: "/knowledge/templates/catalogue",
    resolve: () => ({
      path: "/knowledge/templates/catalogue",
      heading: messages.knowledge.sections.templates.title,
      level: 2,
    }),
  },
  {
    template: "/knowledge/templates/catalogue/$packId/$templateId",
    resolve: ({ id, title }) => ({
      path: `/knowledge/templates/catalogue/${PACK_ID}/${id}`,
      heading: title,
      level: 1,
    }),
  },
  {
    template: "/knowledge/tools/$entry",
    resolve: () => ({
      path: `/knowledge/tools/${tool.slug}`,
      heading: tool.displayName,
      level: 2,
    }),
  },
  {
    template: "/knowledge/tools/contribute",
    resolve: () => ({
      path: "/knowledge/tools/contribute",
      heading: messages.publicTools.contribute.title,
      level: 1,
    }),
  },
] as const satisfies readonly VisitorRoute[];

type VisitorCatalogue =
  | { status: "disabled" }
  | { status: "ready"; template: CatalogueTemplate };

export const declarePublicKnowledgeSmoke = () => {
  test.describe("public visitor routes", () => {
    test.use({ storageState: { cookies: [], origins: [] }, locale: "en-US" });
    let catalogue: VisitorCatalogue = { status: "disabled" };

    test.beforeAll(async ({ request }) => {
      // The target's gate, rather than the runner's build flags, controls this suite.
      const probe = await request.get(PUBLIC_API);
      if (probe.status() === 404) {
        expect(await probe.json()).toEqual({ error: "Not Found" });
        return;
      }
      expect(probe.status()).toBe(200);
      const pack = await request.get(`${PUBLIC_API}/${PACK_ID}`);
      expect(pack.status()).toBe(200);
      const data = v.parse(
        v.object({ templates: v.array(templateSchema) }),
        await pack.json(),
      );
      catalogue = {
        status: "ready",
        template:
          data.templates.at(0) ?? panic("public template pack is empty"),
      };
    });

    const declareRoute = (def: VisitorRoute) => {
      test(def.template, async ({ page }, testInfo) => {
        const current = catalogue;
        if (current.status === "disabled") {
          test.skip(true, "Public Knowledge is disabled in the target");
          return;
        }
        const route = def.resolve(current.template);
        const requests: string[] = [];
        const unauthorized: string[] = [];
        const forbidden: string[] = [];
        const origin = new URL(
          testInfo.project.use.baseURL ?? panic("smoke base URL missing"),
        ).origin;
        const origins = new Set([origin]);
        const apiBaseURL = testInfo.config.metadata["apiBaseURL"];
        if (typeof apiBaseURL === "string") {
          origins.add(new URL(apiBaseURL).origin);
        }
        page.on("request", (request) => {
          const url = new URL(request.url());
          if (!origins.has(url.origin)) {
            return;
          }
          requests.push(url.pathname);
          const pathname = url.pathname.replace(/^\/api(?=\/v1\/)/u, "");
          if (
            (pathname.startsWith("/v1/") &&
              !pathname.startsWith("/v1/public/")) ||
            pathname.startsWith("/api/auth/organization/")
          ) {
            forbidden.push(url.pathname);
          }
        });
        page.on("response", (response) => {
          if (
            origins.has(new URL(response.url()).origin) &&
            response.status() === 401
          ) {
            unauthorized.push(new URL(response.url()).pathname);
          }
        });
        const network = createNetworkCollector();
        const detach = network.trackPage(page);
        try {
          const response = await page.goto(route.path, {
            waitUntil: "domcontentloaded",
          });
          expect(response?.status()).toBe(200);
          expect(response?.headers()["content-type"]).toMatch(
            /^text\/html\b/iu,
          );
          expect(response?.headers()["cache-control"]).toBe(
            "private, no-store",
          );
          await expect(
            page.getByRole("heading", {
              name: route.heading,
              level: route.level,
              exact: true,
            }),
          ).toBeVisible();
          expect(new URL(page.url()).pathname).toBe(route.path);
          await network.waitForQuiet({
            idleMs: 500,
            minimumObservationMs: 1000,
            timeoutMs: 3000,
          });
          expect(forbidden, "member-only requests").toEqual([]);
          expect(unauthorized, "unauthorized responses").toEqual([]);
        } finally {
          detach();
          await testInfo.attach("public-network", {
            body: JSON.stringify({ requests, forbidden, unauthorized }),
            contentType: "application/json",
          });
        }
      });
    };
    for (const def of PUBLIC_VISITOR_ROUTE_DEFS) {
      declareRoute(def);
    }
  });
};
