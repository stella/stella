import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { createBundledTemplatePackCatalogue } from "@stll/template-packs";
import {
  createFixtureTemplatePackCatalogue,
  FIXTURE_TEMPLATE_PACKS,
} from "@stll/template-packs/fixtures";

import { env } from "@/api/env";
import { envApiServerSchema } from "@/api/env-schema";
import {
  createPublicKnowledgeRoute,
  publicKnowledgeRoute,
} from "@/api/handlers/public-knowledge/routes";
import { isSafePublicHandler } from "@/api/lib/api-handlers";

const request = (path: string, cookie?: string) =>
  publicKnowledgeRoute.handle(
    new Request(`http://localhost${path}`, {
      headers: cookie ? { cookie } : undefined,
    }),
  );

const withFeature = async (enabled: boolean, run: () => Promise<void>) => {
  const previous = env.FEATURE_PUBLIC_KNOWLEDGE;
  env.FEATURE_PUBLIC_KNOWLEDGE = enabled;
  try {
    await run();
  } finally {
    env.FEATURE_PUBLIC_KNOWLEDGE = previous;
  }
};

describe("public knowledge routes", () => {
  test("the deployment flag defaults off and hides every route", async () => {
    expect(
      v.parse(envApiServerSchema.FEATURE_PUBLIC_KNOWLEDGE, undefined),
    ).toBe(false);
    await withFeature(false, async () => {
      for (const path of [
        "/public/knowledge/template-packs",
        "/public/knowledge/template-packs/general-legal",
        "/public/knowledge/template-packs/general-legal/templates/mutual-nda",
        "/public/knowledge/template-packs/general-legal/templates/mutual-nda/preview",
        "/public/knowledge/playbook-starters",
        "/public/knowledge/playbook-starters/nda",
      ]) {
        expect((await request(path)).status).toBe(404);
      }
    });
  });

  test("unknown and non-public packs are not readable", async () => {
    await withFeature(true, async () => {
      for (const path of [
        "/public/knowledge/template-packs/not-public",
        "/public/knowledge/template-packs/not-public/templates/nda",
        "/public/knowledge/template-packs/not-public/templates/nda/preview",
      ]) {
        expect((await request(path)).status).toBe(404);
      }
      const privatePack = FIXTURE_TEMPLATE_PACKS.at(0);
      if (!privatePack) {
        throw new Error("Fixture pack missing");
      }
      expect(privatePack.publicDisplay).toBe(false);
      const privateTemplate = privatePack.templates.at(0);
      if (!privateTemplate) {
        throw new Error("Fixture template missing");
      }
      const privateRoute = createPublicKnowledgeRoute(() =>
        createFixtureTemplatePackCatalogue(),
      );
      for (const path of [
        `/public/knowledge/template-packs/${privatePack.id}`,
        `/public/knowledge/template-packs/${privatePack.id}/templates/${privateTemplate.slug}`,
      ]) {
        const response = await privateRoute.handle(
          new Request(`http://localhost${path}`),
        );
        expect(response.status).toBe(404);
      }
    });
  });

  test("session cookies cannot change static responses or set a cookie", async () => {
    await withFeature(true, async () => {
      const paths = [
        "/public/knowledge/template-packs",
        "/public/knowledge/playbook-starters",
        "/public/knowledge/playbook-starters/nda",
      ];
      if (
        createBundledTemplatePackCatalogue(env.TEMPLATE_PACKS_CONTENT_DIR).get(
          "general-legal",
        )
      ) {
        paths.push(
          "/public/knowledge/template-packs/general-legal",
          "/public/knowledge/template-packs/general-legal/templates/mutual-nda",
          "/public/knowledge/template-packs/general-legal/templates/mutual-nda/preview",
        );
      }
      for (const path of paths) {
        const anonymous = await request(path);
        const member = await request(
          path,
          "better-auth.session_token=arbitrary",
        );
        expect(anonymous.status).toBe(200);
        expect(member.status).toBe(200);
        expect(anonymous.headers.get("Cache-Control")).toBe(
          "public, max-age=300",
        );
        expect(anonymous.headers.get("Set-Cookie")).toBeNull();
        expect(member.headers.get("Set-Cookie")).toBeNull();
        expect(await anonymous.text()).toBe(await member.text());
      }
    });
  });

  test("every declared route uses the public handler factory", () => {
    const declared = publicKnowledgeRoute.routes.filter(
      (route) => typeof route.handler === "function",
    );
    expect(
      declared.map((route) => `${route.method} ${route.path}`).toSorted(),
    ).toEqual([
      "GET /public/knowledge/playbook-starters",
      "GET /public/knowledge/playbook-starters/:id",
      "GET /public/knowledge/template-packs",
      "GET /public/knowledge/template-packs/:packId",
      "GET /public/knowledge/template-packs/:packId/templates/:templateId",
      "GET /public/knowledge/template-packs/:packId/templates/:templateId/preview",
    ]);
    expect(declared.every((route) => isSafePublicHandler(route.handler))).toBe(
      true,
    );
  });
});
