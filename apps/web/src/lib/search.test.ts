import { describe, expect, test } from "bun:test";

process.env["VITE_API_URL"] ??= "http://localhost:3001";

const { hasSearchQueryOrSelectiveFilter, searchInfiniteOptions } =
  await import("@/lib/search");

const emptySearch = () => ({
  editedByUserIds: [],
  kinds: [],
  mimeTypes: [],
  query: "",
  types: [],
});

describe("search query enablement", () => {
  test("does not run a blank query scoped only to a workspace", () => {
    expect(
      hasSearchQueryOrSelectiveFilter({
        ...emptySearch(),
        workspaceIds: ["ws_1"],
      }),
    ).toBeFalse();
  });

  test("runs a blank query with a selective filter", () => {
    expect(
      hasSearchQueryOrSelectiveFilter({
        ...emptySearch(),
        kinds: ["document"],
      }),
    ).toBeTrue();
  });

  test("uses the caller-owned gate without splitting the result cache", () => {
    const params = { ...emptySearch(), enabled: false, workspaceIds: [] };
    const disabled = searchInfiniteOptions(params);
    const enabled = searchInfiniteOptions({ ...params, enabled: true });

    expect(disabled.enabled).toBeFalse();
    expect(enabled.enabled).toBeTrue();
    expect(enabled.queryKey).toEqual(disabled.queryKey);
  });
});
