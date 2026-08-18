import { describe, expect, test } from "bun:test";

import {
  CONTACT_IMPORT_LABELED_FIELDS,
  CONTACT_IMPORT_VOCABULARIES,
} from "./contact-import-labeled";

describe("contact import vocabularies", () => {
  test("defines every canonical field exactly once per vocabulary", () => {
    for (const vocabulary of Object.values(CONTACT_IMPORT_VOCABULARIES)) {
      expect(Object.keys(vocabulary.fields).toSorted()).toEqual(
        [...CONTACT_IMPORT_LABELED_FIELDS].toSorted(),
      );
    }
  });

  test("does not assign one normalized label to multiple fields", () => {
    for (const vocabulary of Object.values(CONTACT_IMPORT_VOCABULARIES)) {
      const labels = Object.values(vocabulary.fields).flatMap(
        ({ labels: aliases }) =>
          aliases.map((label) =>
            label
              .normalize("NFD")
              .replace(/\p{Mark}/gu, "")
              .trim()
              .toLowerCase(),
          ),
      );
      expect(new Set(labels).size).toBe(labels.length);
    }
  });
});
