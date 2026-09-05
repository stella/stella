import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  createBundledTemplatePackCatalogue,
  createTemplatePackCatalogue,
} from "./catalogue";
import {
  createFixtureTemplatePackCatalogue,
  FIXTURE_TEMPLATE_PACKS as FIXTURE_PACKS,
} from "./fixtures/catalogue";
import type { GeneratedTemplatePack } from "./schema";

const MISSING_CONTENT_ROOT = path.join(
  import.meta.dir,
  "fixtures",
  "content-not-initialised",
);

const fixturePack = FIXTURE_PACKS[0];
if (!fixturePack) {
  throw new Error("fixture manifest must contain a pack");
}
const fixtureTemplate = fixturePack.templates[0];
if (!fixtureTemplate) {
  throw new Error("fixture pack must contain a template");
}

describe("template pack catalogue", () => {
  test("an uninitialised content root is an empty catalogue, not an error", async () => {
    // The manifest is committed data, so it is populated even where the
    // content submodule is not checked out.
    expect(FIXTURE_PACKS.length).toBeGreaterThan(0);
    const catalogue = createTemplatePackCatalogue({
      packs: FIXTURE_PACKS,
      contentRoot: MISSING_CONTENT_ROOT,
    });

    expect(catalogue.list()).toEqual([]);
    expect(catalogue.get(fixturePack.id)).toBeNull();
    const docx = await catalogue.readTemplateDocx({
      packId: fixturePack.id,
      slug: fixtureTemplate.slug,
    });
    expect(Result.isError(docx)).toBe(true);
  });

  test("reads DOCX bytes whose hash matches the manifest", async () => {
    const catalogue = createFixtureTemplatePackCatalogue(FIXTURE_PACKS);

    const docx = await catalogue.readTemplateDocx({
      packId: fixturePack.id,
      slug: fixtureTemplate.slug,
    });
    if (Result.isError(docx)) {
      throw docx.error;
    }
    expect(docx.value.sha256).toBe(fixtureTemplate.sha256);
    expect(docx.value.bytes.byteLength).toBeGreaterThan(0);
    // DOCX is a zip: PK signature.
    expect(Array.from(docx.value.bytes.subarray(0, 2))).toEqual([0x50, 0x4b]);
    expect(docx.value.fileName).toBe(`${fixtureTemplate.slug}.docx`);
  });

  test("refuses bytes that no longer match the recorded hash", async () => {
    const tampered: GeneratedTemplatePack = {
      ...fixturePack,
      templates: [{ ...fixtureTemplate, sha256: "0".repeat(64) }],
    };
    const catalogue = createFixtureTemplatePackCatalogue([tampered]);

    const docx = await catalogue.readTemplateDocx({
      packId: fixturePack.id,
      slug: fixtureTemplate.slug,
    });
    expect(Result.isError(docx)).toBe(true);
  });

  test("reports a manifest entry whose file is absent", async () => {
    const missingFile: GeneratedTemplatePack = {
      ...fixturePack,
      templates: [
        { ...fixtureTemplate, file: "templates/absent/template.docx" },
      ],
    };
    const catalogue = createFixtureTemplatePackCatalogue([missingFile]);

    const docx = await catalogue.readTemplateDocx({
      packId: fixturePack.id,
      slug: fixtureTemplate.slug,
    });
    expect(Result.isError(docx)).toBe(true);
  });

  test("fixture content exercises the contract: attribution roles, jurisdiction, fields", () => {
    const roles = new Set(fixturePack.authors.map((author) => author.role));
    expect(roles).toEqual(new Set(["drafter", "reviewer", "converter"]));
    expect(fixturePack.jurisdictions.map((j) => j.country)).toEqual(["CZ"]);
    expect(fixtureTemplate.fields.length).toBeGreaterThan(0);
    expect(fixtureTemplate.readme).toContain("Employment agreement");
  });

  // Census over the real bundled content. The catalogue is empty when the
  // content submodule is not checked out, which makes this a no-op there.
  test("every bundled template reads back with its manifest hash", async () => {
    const catalogue = createBundledTemplatePackCatalogue();

    for (const pack of catalogue.list()) {
      for (const template of pack.templates) {
        const docx = await catalogue.readTemplateDocx({
          packId: pack.id,
          slug: template.slug,
        });
        if (Result.isError(docx)) {
          throw docx.error;
        }
        expect(docx.value.sha256).toBe(template.sha256);
      }
    }
  });
});
