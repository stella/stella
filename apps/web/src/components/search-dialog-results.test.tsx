import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";

import { resourceRef, RESOURCE_TYPE, toResourceName } from "@stll/api-contract";

import {
  RecentFileIcon,
  SearchHitIcon,
} from "@/components/search-dialog-results";
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
      client.setQueryData(options.queryKey, {
        entityId: toSafeId<"entity">(recent.entityId),
        kind: "document",
        name: recent.title,
        currentVersionId: toSafeId<"entityVersion">("version_search_image"),
        currentVersionCreatedAt: hit.updatedAt,
        currentVersionReference: null,
        extractionFileFieldId: null,
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
      });
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

test.each([
  [{ kind: "statute", number: "172", year: "2026" }, "172/26"],
  [{ kind: "decision", courtAbbreviation: "NS", courtTier: "supreme" }, "NS"],
  [
    { kind: "decision", courtAbbreviation: "ÚS", courtTier: "constitutional" },
    "ÚS",
  ],
  [{ kind: "decision", courtAbbreviation: null }, 'data-kind="unknown"'],
] as const)(
  "recents render their document identity without fetching file metadata: %j",
  (documentIdentity, label) => {
    const markup = renderToStaticMarkup(
      <RecentFileIcon file={{ ...recent, documentIdentity }} />,
    );
    expect(markup).toContain('data-slot="document-identity-badge"');
    expect(markup).toContain(label);
    expect(markup).not.toContain("/thumbnail/");
  },
);

test.each([
  { color: "--option-red", expected: "var(--option-red)" },
  { color: "#336699", expected: "#336699" },
  { color: null, expected: "var(--option-amber)" },
])(
  "matter search identities preserve their colour: %j",
  ({ color, expected }) => {
    const matterResource = resourceRef({
      type: RESOURCE_TYPE.WORKSPACE,
      id: toSafeId<"workspace">("matter_search_badge"),
    });
    const matter = {
      id: "matter:badge",
      type: "matter",
      resource: matterResource,
      resourceName: toResourceName(matterResource),
      title: "Civil proceeding",
      headline: null,
      updatedAt: hit.updatedAt,
      workspaceId: "matter_search_badge",
      workspaceName: "Civil proceeding",
      color,
    } as const satisfies GlobalSearchHit;
    const markup = renderToStaticMarkup(<SearchHitIcon hit={matter} />);
    expect(markup).not.toContain('data-slot="document-identity-badge"');
    expect(markup).toContain("lucide-layers");
    expect(markup).toContain(`color:${expected}`);
  },
);
