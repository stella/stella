import { panic } from "better-result";

import {
  SHAREPOINT_IMPORT_MAX_ITEMS,
  SHAREPOINT_ITEM_KIND,
  SHAREPOINT_REFUSAL_CODE,
  type SharepointItemKind,
} from "@stll/api-contract/sharepoint";

type NamedRef = { id: string; name: string };

/** Where browsing starts: one SharePoint site, or the member's own OneDrive. */
type SharepointSource = { type: "site"; site: NamedRef } | { type: "onedrive" };

/**
 * Where the picker is. `path` lists the folders opened below the drive's top
 * level, outermost first; empty means the top level.
 */
export type SharepointPickerLocation =
  | { type: "sites" }
  | { type: "drives"; source: SharepointSource }
  | {
      type: "folder";
      source: SharepointSource;
      drive: NamedRef;
      path: readonly NamedRef[];
    };

export const SHAREPOINT_PICKER_START = {
  type: "sites",
} as const satisfies SharepointPickerLocation;

export const openSharepointSource = (
  source: SharepointSource,
): SharepointPickerLocation => ({ type: "drives", source });

export const openSharepointDrive = (
  location: Extract<SharepointPickerLocation, { type: "drives" }>,
  drive: NamedRef,
): SharepointPickerLocation => ({
  type: "folder",
  source: location.source,
  drive: { id: drive.id, name: drive.name },
  path: [],
});

export const openSharepointFolder = (
  location: Extract<SharepointPickerLocation, { type: "folder" }>,
  folder: NamedRef,
): SharepointPickerLocation => ({
  type: "folder",
  source: location.source,
  drive: location.drive,
  path: [...location.path, { id: folder.id, name: folder.name }],
});

/** The open folder's item id, or `null` at the drive's top level. */
export const sharepointFolderId = (
  location: Extract<SharepointPickerLocation, { type: "folder" }>,
): string | null => location.path.at(-1)?.id ?? null;

export type SharepointCrumbLabel =
  { type: "sites" } | { type: "onedrive" } | { type: "name"; name: string };

type SharepointCrumb = {
  key: string;
  label: SharepointCrumbLabel;
  /** Where choosing this crumb goes; the last crumb is the current place. */
  target: SharepointPickerLocation;
};

const sourceLabel = (source: SharepointSource): SharepointCrumbLabel => {
  switch (source.type) {
    case "site":
      return { type: "name", name: source.site.name };
    case "onedrive":
      return { type: "onedrive" };
    default:
      source satisfies never;
      return panic("Unknown SharePoint source");
  }
};

const sourceKey = (source: SharepointSource): string =>
  source.type === "site" ? `site:${source.site.id}` : "onedrive";

/** Every step from the site list to the current place, outermost first. */
export const sharepointBreadcrumb = (
  location: SharepointPickerLocation,
): SharepointCrumb[] => {
  const sites: SharepointCrumb = {
    key: "sites",
    label: { type: "sites" },
    target: SHAREPOINT_PICKER_START,
  };
  switch (location.type) {
    case "sites":
      return [sites];
    case "drives":
      return [
        sites,
        {
          key: sourceKey(location.source),
          label: sourceLabel(location.source),
          target: location,
        },
      ];
    case "folder":
      return [
        sites,
        {
          key: sourceKey(location.source),
          label: sourceLabel(location.source),
          target: { type: "drives", source: location.source },
        },
        {
          key: `drive:${location.drive.id}`,
          label: { type: "name", name: location.drive.name },
          target: {
            type: "folder",
            source: location.source,
            drive: location.drive,
            path: [],
          },
        },
        ...location.path.map((folder, index) => ({
          key: `folder:${folder.id}`,
          label: { type: "name" as const, name: folder.name },
          target: {
            type: "folder" as const,
            source: location.source,
            drive: location.drive,
            path: location.path.slice(0, index + 1),
          },
        })),
      ];
    default:
      location satisfies never;
      return panic("Unknown SharePoint picker location");
  }
};

/** What choosing a listed item does: open a folder, pick a file, or nothing. */
export const sharepointItemAction = (
  kind: SharepointItemKind,
): "open" | "select" | "none" => {
  switch (kind) {
    case SHAREPOINT_ITEM_KIND.folder:
      return "open";
    case SHAREPOINT_ITEM_KIND.file:
      return "select";
    case SHAREPOINT_ITEM_KIND.other:
      return "none";
    default:
      kind satisfies never;
      return panic(`Unknown SharePoint item kind: ${String(kind)}`);
  }
};

export type SharepointSelectedFile = {
  driveId: string;
  itemId: string;
  name: string;
};

const sameFile = (
  a: Pick<SharepointSelectedFile, "driveId" | "itemId">,
  b: Pick<SharepointSelectedFile, "driveId" | "itemId">,
) => a.driveId === b.driveId && a.itemId === b.itemId;

export const isSharepointFileSelected = (
  selection: readonly SharepointSelectedFile[],
  file: Pick<SharepointSelectedFile, "driveId" | "itemId">,
): boolean => selection.some((selected) => sameFile(selected, file));

type SharepointSelectionChange =
  | { type: "changed"; selection: readonly SharepointSelectedFile[] }
  | { type: "limit-reached" };

/**
 * Adds a file to the selection or removes it. One import names at most
 * {@link SHAREPOINT_IMPORT_MAX_ITEMS} files, so adding past that is refused
 * and the selection stays as it was.
 */
export const toggleSharepointFile = (
  selection: readonly SharepointSelectedFile[],
  file: SharepointSelectedFile,
): SharepointSelectionChange => {
  if (isSharepointFileSelected(selection, file)) {
    return {
      type: "changed",
      selection: selection.filter((selected) => !sameFile(selected, file)),
    };
  }
  if (selection.length >= SHAREPOINT_IMPORT_MAX_ITEMS) {
    return { type: "limit-reached" };
  }
  return {
    type: "changed",
    selection: [
      ...selection,
      { driveId: file.driveId, itemId: file.itemId, name: file.name },
    ],
  };
};

type ImportResult = { driveId: string; itemId: string } & (
  | { status: "created" | "versioned" | "unchanged"; name: string }
  | { status: "failed"; code: string }
  // The request ran out of its time budget before this file; send it again.
  | { status: "deferred" }
);

export type SharepointImportOutcome = {
  key: string;
  name: string;
} & (
  | { status: "created" | "versioned" | "unchanged" }
  | { status: "failed"; code: string }
  // No answer settled this file: the rounds stopped while it was deferred,
  // or a later round failed before reaching it. It may or may not be stored.
  | { status: "unconfirmed" }
);

export type SharepointImportSummary = {
  created: number;
  versioned: number;
  unchanged: number;
  failed: number;
  unconfirmed: number;
  /** One line per requested file, in the order the files were picked. */
  outcomes: SharepointImportOutcome[];
};

const resultKey = ({ driveId, itemId }: { driveId: string; itemId: string }) =>
  `${driveId}\u0000${itemId}`;

/** Each file's latest result: a later round's answer replaces a deferral. */
const latestResults = (results: readonly ImportResult[]) =>
  new Map(results.map((result) => [resultKey(result), result]));

/**
 * The picked files still to send: those whose latest result says the request
 * deferred them. Results accumulate across rounds, so a re-sent file's new
 * answer supersedes its deferral.
 */
export const deferredSharepointFiles = (
  selection: readonly SharepointSelectedFile[],
  results: readonly ImportResult[],
): SharepointSelectedFile[] => {
  const latest = latestResults(results);
  return selection.filter(
    (file) => latest.get(resultKey(file))?.status === "deferred",
  );
};

/**
 * Per-file outcomes of one import, named after the picked files: a failed
 * result carries no name of its own. A picked file with no result, or one
 * still deferred when the rounds stopped, is unconfirmed, never a silent
 * success.
 */
export const summarizeSharepointImport = (
  selection: readonly SharepointSelectedFile[],
  results: readonly ImportResult[],
): SharepointImportSummary => {
  const byKey = latestResults(results);
  const outcomes = selection.map((file): SharepointImportOutcome => {
    const key = resultKey(file);
    const result = byKey.get(key);
    if (result === undefined) {
      return { key, name: file.name, status: "unconfirmed" };
    }
    switch (result.status) {
      case "created":
      case "versioned":
      case "unchanged":
        return { key, name: result.name, status: result.status };
      case "failed":
        return { key, name: file.name, status: "failed", code: result.code };
      case "deferred":
        return { key, name: file.name, status: "unconfirmed" };
      default:
        result satisfies never;
        return panic("Unknown SharePoint import status");
    }
  });
  const count = (status: SharepointImportOutcome["status"]) =>
    outcomes.filter((outcome) => outcome.status === status).length;
  return {
    created: count("created"),
    versioned: count("versioned"),
    unchanged: count("unchanged"),
    failed: count("failed"),
    unconfirmed: count("unconfirmed"),
    outcomes,
  };
};

/** Why a SharePoint read was refused, as far as the picker acts on it. */
export type SharepointBrowseRefusal =
  | { type: "not-connected" }
  | { type: "reconnect-required" }
  | { type: "throttled"; retryAfterSeconds: number | null }
  | { type: "other" };

const MS_PER_SECOND = 1000;

export const sharepointBrowseRefusal = ({
  code,
  retryAfterMs,
}: {
  code: string | undefined;
  retryAfterMs: unknown;
}): SharepointBrowseRefusal => {
  switch (code) {
    case undefined:
      return { type: "other" };
    case SHAREPOINT_REFUSAL_CODE.notConnected:
      return { type: "not-connected" };
    case SHAREPOINT_REFUSAL_CODE.reconnectRequired:
      return { type: "reconnect-required" };
    case SHAREPOINT_REFUSAL_CODE.throttled:
      return {
        type: "throttled",
        retryAfterSeconds:
          typeof retryAfterMs === "number" && retryAfterMs > 0
            ? Math.ceil(retryAfterMs / MS_PER_SECOND)
            : null,
      };
    default:
      return { type: "other" };
  }
};
