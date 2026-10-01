import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import * as v from "valibot";

import {
  createBundledTemplatePackCatalogue,
  createTemplatePackCatalogue,
  TemplatePackContentError,
} from "@stll/template-packs";
import {
  createFixtureTemplatePackCatalogue,
  FIXTURE_TEMPLATE_PACKS,
  fixtureTemplatePackContentRoot,
} from "@stll/template-packs/fixtures";

import { env } from "@/api/env";
import { envApiServerSchema } from "@/api/env-schema";
import {
  createPublicKnowledgeRoute,
  publicKnowledgeRoute,
} from "@/api/handlers/public-knowledge/routes";
import { isSafePublicHandler } from "@/api/lib/api-handlers";
import { fileSecurityRejection } from "@/api/lib/file-scan/rejection";
import {
  FileScanRejectedError,
  scanUpload,
} from "@/api/lib/file-scan/scan-upload";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";

const request = async (path: string, cookie?: string) =>
  await publicKnowledgeRoute.handle(
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
        const response = await request(path);
        expect(response.status).toBe(404);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      }
    });
  });

  test("unknown and non-public packs are not readable", async () => {
    await withFeature(true, async () => {
      for (const path of [
        "/public/knowledge/template-packs/not-public",
        "/public/knowledge/template-packs/not-public/templates/nda",
        "/public/knowledge/template-packs/not-public/templates/nda/preview",
        "/public/knowledge/playbook-starters/unknown",
      ]) {
        const response = await request(path);
        expect(response.status).toBe(404);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      }
      const invalid = await request(
        `/public/knowledge/template-packs/${"a".repeat(65)}`,
      );
      expect(invalid.status).toBeGreaterThanOrEqual(400);
      expect(invalid.headers.get("Cache-Control")).toBe("private, no-store");
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
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      }
    });
  });

  test.each([
    "missing",
    "empty",
    "zero-byte",
    "directory",
    "inaccessible-ancestor",
    "unreadable",
    "io-error",
  ] as const)(
    "unavailable template content returns an empty public list (%s)",
    async (state) => {
      const fixture =
        FIXTURE_TEMPLATE_PACKS.at(0) ?? panic("Fixture pack missing");
      const publicPack = { ...fixture, publicDisplay: true };
      expect(
        createFixtureTemplatePackCatalogue([publicPack]).list(),
      ).toHaveLength(1);
      const directory = mkdtempSync(
        nodePath.join(tmpdir(), "public-template-content-"),
      );
      const contentRoot = nodePath.join(directory, "content");
      try {
        if (state !== "missing") {
          mkdirSync(nodePath.join(contentRoot, "packs"), { recursive: true });
        }
        if (state === "zero-byte" || state === "directory") {
          for (const template of publicPack.templates) {
            const file = nodePath.join(
              contentRoot,
              "packs",
              publicPack.id,
              template.file,
            );
            mkdirSync(nodePath.dirname(file), { recursive: true });
            if (state === "directory") {
              mkdirSync(file, { recursive: true });
            } else {
              writeFileSync(file, "");
            }
          }
        }
        if (
          state === "inaccessible-ancestor" ||
          state === "unreadable" ||
          state === "io-error"
        ) {
          cpSync(fixtureTemplatePackContentRoot(), contentRoot, {
            recursive: true,
          });
          const template =
            publicPack.templates.at(0) ?? panic("Fixture template missing");
          const file = nodePath.join(
            contentRoot,
            "packs",
            publicPack.id,
            template.file,
          );
          if (state === "inaccessible-ancestor") {
            chmodSync(nodePath.join(contentRoot, "packs"), 0);
          } else if (state === "unreadable") {
            chmodSync(file, 0);
          } else {
            rmSync(file);
            symlinkSync(nodePath.basename(file), file);
          }
        }
        const catalogue = createTemplatePackCatalogue({
          packs: [publicPack],
          contentRoot,
          availability: "readable",
        });
        const route = createPublicKnowledgeRoute(() => catalogue);
        await withFeature(true, async () => {
          const response = await route.handle(
            new Request("http://localhost/public/knowledge/template-packs"),
          );
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ items: [] });
          const template =
            publicPack.templates.at(0) ?? panic("Fixture template missing");
          const packPath = `/public/knowledge/template-packs/${publicPack.id}`;
          for (const path of [
            packPath,
            `${packPath}/templates/${template.slug}`,
            `${packPath}/templates/${template.slug}/preview`,
          ]) {
            const missing = await route.handle(
              new Request(`http://localhost${path}`),
            );
            expect(missing.status).toBe(404);
            expect(missing.headers.get("Cache-Control")).toBe(
              "private, no-store",
            );
          }
        });
      } finally {
        if (state === "inaccessible-ancestor") {
          chmodSync(nodePath.join(contentRoot, "packs"), 0o755);
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  test("two preview requests scan and render the static bytes once", async () => {
    await withFeature(true, async () => {
      const pack = FIXTURE_TEMPLATE_PACKS.at(0);
      const template = pack?.templates.at(0);
      if (!pack || !template) {
        throw new Error("Fixture template missing");
      }
      const catalogue = createFixtureTemplatePackCatalogue([
        { ...pack, publicDisplay: true },
      ]);
      let scans = 0;
      const rendered: ScannedFile[] = [];
      const route = createPublicKnowledgeRoute(() => catalogue, {
        scan: async (input) => {
          scans += 1;
          return await scanUpload(input);
        },
        renderPreview: async (file) => {
          rendered.push(file);
          return await Promise.resolve({
            paragraphs: [],
            charCount: 0,
            structureErrors: [],
            clauseSlots: [],
          });
        },
      });
      const path = `/public/knowledge/template-packs/${pack.id}/templates/${template.slug}/preview`;
      const first = await route.handle(new Request(`http://localhost${path}`));
      const second = await route.handle(new Request(`http://localhost${path}`));
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await first.text()).toBe(await second.text());
      expect(scans).toBe(1);
      expect(rendered).toHaveLength(1);
      expect(rendered[0]?.source.type).toBe("scan");
    });
  });

  test("a rejecting scan of bundled bytes is a server fault", async () => {
    await withFeature(true, async () => {
      const pack = FIXTURE_TEMPLATE_PACKS.at(0);
      const template = pack?.templates.at(0);
      if (!pack || !template) {
        throw new Error("Fixture template missing");
      }
      const catalogue = createFixtureTemplatePackCatalogue([
        { ...pack, publicDisplay: true },
      ]);
      const rejection = fileSecurityRejection({
        verdict: "reject",
        findings: [
          { rule: "corrupt-zip", severity: "reject", message: "not a zip" },
        ],
      });
      if (!rejection) {
        throw new Error("Rejection fixture missing");
      }
      let scans = 0;
      let renders = 0;
      const route = createPublicKnowledgeRoute(() => catalogue, {
        scan: async () => {
          scans += 1;
          return await Promise.resolve(
            Result.err(
              new FileScanRejectedError({
                message: rejection.message,
                rejection,
              }),
            ),
          );
        },
        renderPreview: async () => {
          renders += 1;
          return await Promise.resolve({
            paragraphs: [],
            charCount: 0,
            structureErrors: [],
            clauseSlots: [],
          });
        },
      });
      const path = `/public/knowledge/template-packs/${pack.id}/templates/${template.slug}/preview`;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await route.handle(
          new Request(`http://localhost${path}`),
        );
        expect(response.status).toBe(503);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        const body = await response.text();
        expect(body).toContain("Preview unavailable");
        expect(body).not.toContain("not a zip");
      }
      // The verdict on hash-verified bytes is kept: the file is scanned once.
      expect(scans).toBe(1);
      expect(renders).toBe(0);
    });
  });

  test.each(["unreadable", "io-error"] as const)(
    "content becoming unavailable after advertisement returns a typed preview failure (%s)",
    async (state) => {
      const fixture =
        FIXTURE_TEMPLATE_PACKS.at(0) ?? panic("Fixture pack missing");
      const template =
        fixture.templates.at(0) ?? panic("Fixture template missing");
      const pack = { ...fixture, publicDisplay: true };
      const contentRoot = mkdtempSync(
        nodePath.join(tmpdir(), "public-template-read-"),
      );
      cpSync(fixtureTemplatePackContentRoot(), contentRoot, {
        recursive: true,
      });
      try {
        const catalogue = createTemplatePackCatalogue({
          packs: [pack],
          contentRoot,
          availability: "readable",
        });
        expect(catalogue.list()).toHaveLength(1);
        const route = createPublicKnowledgeRoute(() => catalogue);
        const file = nodePath.join(
          contentRoot,
          "packs",
          pack.id,
          template.file,
        );
        if (state === "unreadable") {
          chmodSync(file, 0);
        } else {
          rmSync(file);
          symlinkSync(nodePath.basename(file), file);
        }
        await withFeature(true, async () => {
          const packPath = `/public/knowledge/template-packs/${pack.id}`;
          for (const path of [
            packPath,
            `${packPath}/templates/${template.slug}`,
          ]) {
            expect(
              (await route.handle(new Request(`http://localhost${path}`)))
                .status,
            ).toBe(200);
          }
          const response = await route.handle(
            new Request(
              `http://localhost${packPath}/templates/${template.slug}/preview`,
            ),
          );
          expect(response.status).toBe(503);
          expect(response.headers.get("Cache-Control")).toBe(
            "private, no-store",
          );
          expect(await response.text()).not.toContain(contentRoot);
        });
      } finally {
        rmSync(contentRoot, { recursive: true, force: true });
      }
    },
  );

  test("unreadable bytes for an advertised template are a server fault", async () => {
    await withFeature(true, async () => {
      const pack = FIXTURE_TEMPLATE_PACKS.at(0);
      const template = pack?.templates.at(0);
      if (!pack || !template) {
        throw new Error("Fixture template missing");
      }
      const catalogue = createFixtureTemplatePackCatalogue([
        { ...pack, publicDisplay: true },
      ]);
      const route = createPublicKnowledgeRoute(() => ({
        ...catalogue,
        readTemplateDocx: async (ref) =>
          Result.err(
            new TemplatePackContentError({
              message: "hash mismatch",
              packId: ref.packId,
              slug: ref.slug,
            }),
          ),
      }));
      const response = await route.handle(
        new Request(
          `http://localhost/public/knowledge/template-packs/${pack.id}/templates/${template.slug}/preview`,
        ),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).not.toContain("hash mismatch");
    });
  });

  test("renderer failures are not shared-cacheable", async () => {
    await withFeature(true, async () => {
      const pack = FIXTURE_TEMPLATE_PACKS.at(0);
      const template = pack?.templates.at(0);
      if (!pack || !template) {
        throw new Error("Fixture template missing");
      }
      const catalogue = createFixtureTemplatePackCatalogue([
        { ...pack, publicDisplay: true },
      ]);
      const route = createPublicKnowledgeRoute(() => catalogue, {
        renderPreview: async () => {
          throw new Error("Preview failed");
        },
      });
      const response = await route.handle(
        new Request(
          `http://localhost/public/knowledge/template-packs/${pack.id}/templates/${template.slug}/preview`,
        ),
      );
      expect(response.status).toBe(500);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
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
