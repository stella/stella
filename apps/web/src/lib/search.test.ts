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

type SearchEnablementParams = Parameters<
  typeof hasSearchQueryOrSelectiveFilter
>[0];

const selectiveFilterCases = [
  { name: "an entity kind", values: { kinds: ["document"] } },
  { name: "a result type", values: { types: ["document"] } },
  { name: "an editor", values: { editedByUserIds: ["user_1"] } },
  { name: "a MIME type", values: { mimeTypes: ["application/pdf"] } },
  {
    name: "an updated-from timestamp",
    values: { updatedFrom: "2026-04-23T12:00:00.000Z" },
  },
  {
    name: "an updated-to timestamp",
    values: { updatedTo: "2026-04-30T12:00:00.000Z" },
  },
] satisfies {
  name: string;
  values: Partial<SearchEnablementParams>;
}[];

describe("search query enablement", () => {
  test("does not run a blank query scoped only to a workspace", () => {
    expect(
      hasSearchQueryOrSelectiveFilter({
        ...emptySearch(),
        workspaceIds: ["ws_1"],
      }),
    ).toBeFalse();
  });

  test.each(selectiveFilterCases)(
    "runs a blank query with $name",
    ({ values }) => {
      expect(
        hasSearchQueryOrSelectiveFilter({
          ...emptySearch(),
          ...values,
        }),
      ).toBeTrue();
    },
  );

  test("uses the caller-owned gate without splitting the result cache", () => {
    const params = { ...emptySearch(), enabled: false, workspaceIds: [] };
    const disabled = searchInfiniteOptions(params);
    const enabled = searchInfiniteOptions({ ...params, enabled: true });

    expect(disabled.enabled).toBeFalse();
    expect(enabled.enabled).toBeTrue();
    expect(enabled.queryKey).toEqual(disabled.queryKey);
  });
});
