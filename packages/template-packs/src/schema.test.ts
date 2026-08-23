import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { packManifestSchema } from "./schema";

const validTemplate = {
  slug: "sample-template",
  title: "Sample template",
  file: "template.docx",
  readme: "README.md",
};

const validManifest = {
  id: "sample-pack",
  name: "Sample pack",
  version: "1.0.0",
  license: "CC0-1.0",
  templates: [validTemplate],
};

describe("template pack manifest contract", () => {
  test("rejects unknown fields in repo-owned manifests", () => {
    expect(v.safeParse(packManifestSchema, validManifest).success).toBe(true);
    expect(
      v.safeParse(packManifestSchema, {
        ...validManifest,
        licenceUrl: "https://example.test/license",
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(packManifestSchema, {
        ...validManifest,
        jurisdictions: [{ country: "CZ", subdivisionName: "Praha" }],
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(packManifestSchema, {
        ...validManifest,
        authors: [{ name: "A", role: "drafter", org: "Example" }],
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(packManifestSchema, {
        ...validManifest,
        source: {
          name: "Example",
          url: "https://example.test/source",
          archiveUrl: "https://example.test/archive",
        },
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(packManifestSchema, {
        ...validManifest,
        templates: [
          {
            ...validTemplate,
            misspelledLicense: "CC0-1.0",
          },
        ],
      }).success,
    ).toBe(false);
  });
});
