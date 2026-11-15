import { describe, expect, test } from "bun:test";

import {
  createOpaqueOrganizationSlug,
  OPAQUE_ORGANIZATION_SLUG_PATTERN,
  ORGANIZATION_OPAQUE_SLUG_BYTES,
  ORGANIZATION_SLUG_RULES,
} from "./contract";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

const fromBytes = (source: Uint8Array) => (bytes: Uint8Array) => {
  bytes.set(source.subarray(0, bytes.length));
};

describe("opaque organization slugs", () => {
  test("each byte position covers the lowercase base32 alphabet uniformly", () => {
    for (
      let position = 0;
      position < ORGANIZATION_OPAQUE_SLUG_BYTES;
      position += 1
    ) {
      const suffixes = Array.from({ length: 256 }, (_, value) => {
        const source = new Uint8Array(ORGANIZATION_OPAQUE_SLUG_BYTES);
        source[position] = value;
        const slug = createOpaqueOrganizationSlug(fromBytes(source));
        expect(slug).toMatch(/^org-[a-z2-7]{10}$/u);
        const suffix = slug.slice(4);
        expect(suffix.slice(0, position)).toBe("a".repeat(position));
        expect(suffix.slice(position + 1)).toBe(
          "a".repeat(ORGANIZATION_OPAQUE_SLUG_BYTES - position - 1),
        );
        return suffix;
      });
      for (const symbol of BASE32_ALPHABET) {
        expect(
          suffixes.filter((suffix) => suffix.at(position) === symbol),
        ).toHaveLength(8);
      }
    }
  });

  test("a random source cannot change the identifier length", () => {
    for (const length of [0, 9, 11, 256]) {
      const slug = createOpaqueOrganizationSlug((bytes) => {
        bytes.set(new Uint8Array(length).fill(1).subarray(0, bytes.length));
      });
      expect(slug).toMatch(/^org-[a-z2-7]{10}$/u);
    }
    expect(createOpaqueOrganizationSlug(() => undefined)).toBe(
      "org-aaaaaaaaaa",
    );
  });

  test("the same bytes produce the same identifier", () => {
    const source = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 31]);
    expect(createOpaqueOrganizationSlug(fromBytes(source))).toBe(
      "org-abcdefghi7",
    );
    expect(
      createOpaqueOrganizationSlug(
        fromBytes(new Uint8Array(ORGANIZATION_OPAQUE_SLUG_BYTES).fill(255)),
      ),
    ).toBe("org-7777777777");
  });

  test("the default source yields distinct slugs that satisfy the slug rules", () => {
    const slugs = new Set(
      Array.from({ length: 64 }, () => createOpaqueOrganizationSlug()),
    );
    expect(slugs.size).toBe(64);
    for (const slug of slugs) {
      expect(slug).toMatch(OPAQUE_ORGANIZATION_SLUG_PATTERN);
      expect(slug).toMatch(ORGANIZATION_SLUG_RULES.pattern);
      expect(slug.length).toBeLessThanOrEqual(
        ORGANIZATION_SLUG_RULES.maxLength,
      );
    }
  });
});
