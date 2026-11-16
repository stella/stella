import { describe, expect, test } from "bun:test";

import {
  type CaseLawSearchChange,
  nextCaseLawIndexSearch,
  SEARCH_CHANGE_RETIRES_FILTER_NOTICE,
} from "./-case-law-search-navigation.logic";
import type { CaseLawIndexSearch } from "./-case-law-search-schema";

const notice = [
  { field: "court", value: "Ústavný súd SR", countries: ["SVK"] },
] satisfies CaseLawIndexSearch["filterNotice"];

const previous = {
  country: "cze",
  q: "odpovědnost za škodu",
  page: 3,
  filterNotice: notice,
} satisfies CaseLawIndexSearch;

const isSearchChange = (key: string): key is CaseLawSearchChange =>
  key in SEARCH_CHANGE_RETIRES_FILTER_NOTICE;

const changes = Object.keys(SEARCH_CHANGE_RETIRES_FILTER_NOTICE).filter(
  isSearchChange,
);

describe("a case-law search change", () => {
  const noticeAfter = (change: CaseLawSearchChange) =>
    nextCaseLawIndexSearch({
      previous,
      pendingQuery: null,
      change,
      apply: (search) => search,
    }).filterNotice;

  // The notice explains filters a country left out; they stay absent through
  // a new sort or page size, so the explanation stays with them.
  test("keeps the filter notice through a sort change", () => {
    expect(noticeAfter("sort")).toEqual(notice);
  });

  test("keeps the filter notice through a page-size change", () => {
    expect(noticeAfter("page-size")).toEqual(notice);
  });

  test("retires the filter notice when a filter changes", () => {
    expect(noticeAfter("filter")).toBeUndefined();
  });

  test.each(changes)(
    "%s keeps or retires the notice as its kind says",
    (change) => {
      expect(noticeAfter(change)).toEqual(
        SEARCH_CHANGE_RETIRES_FILTER_NOTICE[change] ? undefined : notice,
      );
    },
  );

  test.each(changes)(
    "%s drops the page and folds in pending text",
    (change) => {
      const next = nextCaseLawIndexSearch({
        previous,
        pendingQuery: "náhrada škody",
        change,
        apply: (search) => search,
      });
      expect(next.page).toBeUndefined();
      expect(next.q).toBe("náhrada škody");
    },
  );
});
