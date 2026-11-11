import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import { SHAREPOINT_ROOT_ITEM_ID } from "@/api/handlers/sharepoint/graph-client";
import { paginationCursorSchema } from "@/api/lib/custom-schema";

// Microsoft Graph ids are opaque: site ids join a host name and two GUIDs
// with commas, drive ids are base64url with a `b!` prefix, item ids are
// alphanumeric with `!` on personal drives. The pattern admits exactly those
// characters and must start alphanumeric, so an id can never carry a path
// separator, a query, or a `.`/`..` dot segment into the Graph URL it is
// encoded into.
const GRAPH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._,!-]*$/u;
const GRAPH_ID_MAX_LENGTH = 512;

const graphIdSchema = (description: string) =>
  v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(GRAPH_ID_MAX_LENGTH),
    v.regex(GRAPH_ID_PATTERN),
    v.description(description),
  );

export const sharepointSiteIdSchema = graphIdSchema(
  "SharePoint site id, as returned by the site listing",
);

export const sharepointDriveIdSchema = graphIdSchema(
  "Drive (document library or OneDrive) id, as returned by a drive listing",
);

export const sharepointFolderIdSchema = graphIdSchema(
  `Folder item id from a previous listing, or "${SHAREPOINT_ROOT_ITEM_ID}" for the top of the drive`,
);

/** A Graph next-page query string can run long; the bound is still finite. */
export const sharepointCursorSchema = paginationCursorSchema({
  maxChars: 4096,
});

export const SHAREPOINT_DEFAULT_PAGE_SIZE = 100;

export const sharepointLimitSchema = numberFromString(
  v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200)),
);
