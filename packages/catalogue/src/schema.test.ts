import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { loadCatalogue } from "./loader";
import { catalogueSlugSchema, mcpEntrySchema } from "./schema";

const UUIDS = [
  "550e8400-e29b-41d4-a716-446655440000",
  "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D",
];

describe("catalogue slugs", () => {
  test("accept kebab-case names", () => {
    for (const slug of ["sanctions", "czech-registry", "2fa-helper"]) {
      expect(v.safeParse(catalogueSlugSchema, slug).success).toBe(true);
    }
  });

  // Slugs share `/knowledge/tools/<name>` with organizations' skills, whose
  // ids are UUIDs: a UUID-shaped slug could open the wrong page.
  test("refuse a UUID, even one that is otherwise valid kebab-case", () => {
    for (const uuid of UUIDS) {
      expect(v.safeParse(catalogueSlugSchema, uuid).success).toBe(false);
    }
  });

  test("refuse the names of pages beside the entries", () => {
    expect(v.safeParse(catalogueSlugSchema, "contribute").success).toBe(false);
  });

  test("every bundled entry has a slug the schema accepts", () => {
    const refused = loadCatalogue()
      .map(({ slug }) => slug)
      .filter((slug) => !v.safeParse(catalogueSlugSchema, slug).success);
    expect(refused).toEqual([]);
  });
});

test("catalogue authorization definitions use endpoint origins", () => {
  const entry = {
    kind: "mcp",
    slug: "example",
    displayName: "Example",
    description: "Example connector",
    url: "https://connector.example.com/mcp",
    authType: "oauth",
    cost: "free",
    setup: "account",
    jurisdictions: [],
    author: "Example",
    tags: [],
    license: "MIT",
  };
  for (const origin of [
    "https://authorization.example.com",
    "https://authorization.example.com/token",
  ]) {
    const parsed = v.safeParse(mcpEntrySchema, {
      ...entry,
      oauthAuthorization: {
        issuer: "https://authorization.example.com",
        endpointOrigins: [origin],
      },
    });
    expect(parsed.success).toBe(origin === "https://authorization.example.com");
  }
});
