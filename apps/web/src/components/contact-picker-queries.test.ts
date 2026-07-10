import { describe, expect, test } from "bun:test";

import { contactPickerSearchOptions } from "@/components/contact-picker-queries";

describe("contact picker query identity", () => {
  test("INVARIANT: identical searches in different organizations never share cache data", () => {
    const filters = { q: "Novák", type: "person" } as const;
    const first = contactPickerSearchOptions({
      organizationId: "org-a",
      ...filters,
    });
    const second = contactPickerSearchOptions({
      organizationId: "org-b",
      ...filters,
    });

    expect(first.queryKey).not.toEqual(second.queryKey);
  });

  test("search inputs remain explicit parts of cache identity", () => {
    const organizationId = "org-a";
    const personSearch = contactPickerSearchOptions({
      organizationId,
      q: "Alex",
      type: "person",
    });
    const organizationSearch = contactPickerSearchOptions({
      organizationId,
      q: "Alex",
      type: "organization",
    });
    const otherText = contactPickerSearchOptions({
      organizationId,
      q: "Lex",
      type: "person",
    });

    expect(personSearch.queryKey).not.toEqual(organizationSearch.queryKey);
    expect(personSearch.queryKey).not.toEqual(otherText.queryKey);
  });
});
