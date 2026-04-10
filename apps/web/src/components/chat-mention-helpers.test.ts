import { describe, expect, test } from "bun:test";

import {
  buildWorkspaceMentionOptions,
  getMentionViewScope,
} from "@/components/chat-mention-helpers";

describe("buildWorkspaceMentionOptions", () => {
  test("includes only workspaces that have an openable view and preserves workspace ids", () => {
    expect(
      buildWorkspaceMentionOptions({
        firstViewIdsByWorkspaceId: {
          ws_alpha: "view_alpha",
          ws_beta: null,
        },
        workspaces: [
          { id: "ws_alpha", name: "Alpha Matter" },
          { id: "ws_beta", name: "Beta Matter" },
        ],
      }),
    ).toEqual([
      {
        id: "ws_alpha",
        label: "Alpha Matter",
        category: "workspace",
        kind: "workspace",
        mimeType: null,
        sourceViewId: "view_alpha",
      },
    ]);
  });
});

describe("getMentionViewScope", () => {
  test("returns the selected view filters and sorts for mention queries", () => {
    expect(
      getMentionViewScope({
        filters: [
          {
            id: "filter-1",
            field: "property",
            propertyId: "name",
            op: "contains",
            value: "nda",
          },
        ],
        sorts: [{ propertyId: "updatedAt", desc: true }],
      }),
    ).toEqual({
      filters: [
        {
          id: "filter-1",
          field: "property",
          propertyId: "name",
          op: "contains",
          value: "nda",
        },
      ],
      sorts: [{ propertyId: "updatedAt", desc: true }],
    });
  });

  test("falls back to an empty scope when no view is available", () => {
    expect(getMentionViewScope(null)).toEqual({
      filters: [],
      sorts: [],
    });
  });
});
