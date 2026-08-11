import { describe, expect, test } from "bun:test";

import { contactPickerSearchOptions } from "@/components/contact-picker-queries";
import { contactsKeys } from "@/lib/contacts/queries";
import { contactsQueryRoot } from "@/lib/resource-query-roots.logic";

describe("contact picker cache coverage", () => {
  test("INVARIANT: every contacts invalidation prefix-matches the picker key", () => {
    const organizationId = "org-a";
    const { queryKey } = contactPickerSearchOptions({
      organizationId,
      q: "Novák",
      type: "person",
    });

    for (const prefix of [
      contactsQueryRoot(),
      contactsKeys.scoped(organizationId),
      contactsKeys.lists(organizationId),
    ]) {
      expect(queryKey.slice(0, prefix.length)).toEqual([...prefix]);
    }
  });
});

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
