import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";

import { resourceRef, RESOURCE_TYPE, toResourceName } from "@stll/api-contract";

import { SearchHitIcon } from "@/components/search-dialog-results";
import type { GlobalSearchHit } from "@/lib/api-contract";
import { toSafeId } from "@/lib/safe-id";

const resource = resourceRef({
  type: RESOURCE_TYPE.ENTITY,
  id: toSafeId<"entity">("entity_search_image"),
});
const hit = {
  id: "document:entity_search_image",
  type: "document",
  resource,
  resourceName: toResourceName(resource),
  title: "Image",
  headline: null,
  updatedAt: "2026-09-30T00:00:00.000Z",
  entityId: "entity_search_image",
  workspaceId: "matter_search_image",
  workspaceName: "Matter",
  parentId: null,
  lastEditedByName: null,
  lastEditedByImage: null,
  fileFieldId: "field_search_image",
  filePropertyId: "property_search_image",
  mimeType: "image/png",
} as const satisfies GlobalSearchHit;

test.each([
  { mimeType: "image/png", fileFieldId: hit.fileFieldId, thumbnail: true },
  { mimeType: "image/jpeg", fileFieldId: hit.fileFieldId, thumbnail: true },
  {
    mimeType: "application/pdf",
    fileFieldId: hit.fileFieldId,
    thumbnail: false,
  },
  { mimeType: null, fileFieldId: hit.fileFieldId, thumbnail: false },
  { mimeType: "image/png", fileFieldId: null, thumbnail: false },
])(
  "search uses a matter-scoped thumbnail only for an identified image: %j",
  ({ mimeType, fileFieldId, thumbnail }) => {
    const markup = renderToStaticMarkup(
      <SearchHitIcon hit={{ ...hit, mimeType, fileFieldId }} />,
    );
    expect(markup.includes("<img")).toBe(thumbnail);
    if (thumbnail) {
      expect(markup).toContain(
        "/files/matter_search_image/thumbnail/field_search_image",
      );
      expect(markup).toContain('alt=""');
      expect(markup).toContain("size-4");
      expect(markup).toContain('loading="lazy"');
    }
  },
);

test("a non-document search hit keeps its kind icon even with image metadata", () => {
  const markup = renderToStaticMarkup(
    <SearchHitIcon hit={{ ...hit, type: "task" }} />,
  );
  expect(markup).not.toContain("<img");
});
