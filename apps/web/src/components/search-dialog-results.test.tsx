import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";

import { resourceRef, RESOURCE_TYPE, toResourceName } from "@stll/api-contract";

import {
  RecentFileIcon,
  SearchHitIcon,
} from "@/components/search-dialog-results";
import type { api } from "@/lib/api";
import type { GlobalSearchHit } from "@/lib/api-contract";
import { toSafeId } from "@/lib/safe-id";
import type { RecentFile } from "@/lib/search-recents";
import { entityOptions } from "@/lib/workspaces/queries/entities";

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
  { mimeType: "image/png", fileFieldId: hit.fileFieldId },
  { mimeType: "image/jpeg", fileFieldId: hit.fileFieldId },
  { mimeType: "application/pdf", fileFieldId: hit.fileFieldId },
  { mimeType: null, fileFieldId: hit.fileFieldId },
  { mimeType: "image/png", fileFieldId: null },
])(
  "shared search hits keep type icons without thumbnail availability: %j",
  ({ mimeType, fileFieldId }) => {
    const markup = renderToStaticMarkup(
      <SearchHitIcon hit={{ ...hit, mimeType, fileFieldId }} />,
    );
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("/thumbnail/");
  },
);

test("a non-document search hit keeps its kind icon even with image metadata", () => {
  const markup = renderToStaticMarkup(
    <SearchHitIcon hit={{ ...hit, type: "task" }} />,
  );
  expect(markup).not.toContain("<img");
});

const recent = {
  entityId: hit.entityId,
  workspaceId: hit.workspaceId,
  workspaceName: hit.workspaceName,
  title: hit.title,
  fileFieldId: hit.fileFieldId,
  filePropertyId: hit.filePropertyId,
  mimeType: hit.mimeType,
  openedAt: hit.updatedAt,
} as const satisfies RecentFile;

type CachedEntityFields = Pick<
  NonNullable<
    Awaited<
      ReturnType<ReturnType<ReturnType<typeof api.entities>["entity"]>["get"]>
    >["data"]
  >,
  "fields"
>;

test.each([
  {
    cached: false,
    encrypted: false,
    thumbnailFileId: "thumb_ready",
    thumbnail: false,
  },
  {
    cached: true,
    encrypted: false,
    thumbnailFileId: "thumb_ready",
    thumbnail: true,
  },
  {
    cached: true,
    encrypted: true,
    thumbnailFileId: "thumb_ready",
    thumbnail: false,
  },
  { cached: true, encrypted: false, thumbnailFileId: null, thumbnail: false },
])(
  "recents request thumbnails only with cached generated unencrypted metadata: %j",
  ({ cached, encrypted, thumbnailFileId, thumbnail }) => {
    const client = new QueryClient();
    const options = entityOptions(recent.workspaceId, recent.entityId);
    if (cached) {
      const entity = {
        fields: [
          {
            id: toSafeId<"field">(hit.fileFieldId),
            propertyId: toSafeId<"property">(hit.filePropertyId),
            content: {
              type: "file",
              version: 1,
              id: "file_search_image",
              fileName: "image.png",
              mimeType: "image/png",
              sizeBytes: 100,
              encrypted,
              sha256Hex: "sha_search_image",
              pdfFileId: null,
              thumbnailFileId,
            },
          },
        ],
      } as const satisfies CachedEntityFields;
      client.setQueryData(options.queryKey, entity);
    }
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <RecentFileIcon file={recent} />
      </QueryClientProvider>,
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
    expect(client.getQueryState(options.queryKey)?.fetchStatus).toBe("idle");
    client.clear();
  },
);
