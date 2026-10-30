import { describe, expect, test } from "bun:test";

import {
  createOrganizationSlug,
  ORGANIZATION_SLUG_RANDOM_BYTES,
} from "./organization-create";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

describe("opaque organization slug encoding", () => {
  test("each byte position covers the lowercase base32 alphabet uniformly", () => {
    for (
      let position = 0;
      position < ORGANIZATION_SLUG_RANDOM_BYTES;
      position += 1
    ) {
      const slugs = Array.from({ length: 256 }, (_, value) => {
        const bytes = new Uint8Array(ORGANIZATION_SLUG_RANDOM_BYTES);
        bytes[position] = value;
        const slug = createOrganizationSlug(bytes);
        expect(slug).toMatch(/^org-[a-z2-7]{10}$/u);
        const suffix = slug.slice(4);
        expect(suffix.slice(0, position)).toBe("a".repeat(position));
        expect(suffix.slice(position + 1)).toBe(
          "a".repeat(ORGANIZATION_SLUG_RANDOM_BYTES - position - 1),
        );
        return suffix;
      });
      for (const symbol of BASE32_ALPHABET) {
        expect(
          slugs.filter((slug) => slug.at(position) === symbol),
        ).toHaveLength(8);
      }
    }
  });

  test("an invalid byte count cannot produce an identifier", () => {
    for (const length of [0, 9, 11, 256]) {
      expect(() => createOrganizationSlug(new Uint8Array(length))).toThrow(
        "Organization slugs require exactly ten random bytes",
      );
    }
  });

  test("the same supplied bytes preserve a replayed opaque identifier", () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 31]);
    expect(createOrganizationSlug(bytes)).toBe("org-abcdefghi7");
    expect(createOrganizationSlug(bytes.slice())).toBe(
      createOrganizationSlug(bytes),
    );
    expect(
      createOrganizationSlug(
        new Uint8Array(ORGANIZATION_SLUG_RANDOM_BYTES).fill(255),
      ),
    ).toBe("org-7777777777");
  });
});
