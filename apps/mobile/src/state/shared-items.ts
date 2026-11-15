import { panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";

import type { PickedFile } from "@/state/chat-attachments";

/**
 * What the share extension (`share-extension/ShareViewController.swift`)
 * hands over: a folder in the App Group's inbox per share, named
 * `<milliseconds since 1970>-<UUID>`, holding each shared file under its
 * index and a manifest that lists files, links and text in the order shared.
 */

/** A share the app could not read: gone, never finished, or not what the extension writes. */
export class SharedItemsError extends TaggedError("SharedItemsError")<{
  message: string;
  cause?: unknown;
}> {}

/** Written last by the extension: a folder without it is still being copied, or was abandoned. */
export const SHARE_MANIFEST = "manifest.json";

/**
 * How long a share waits for the app before it is deleted. The extension
 * deletes on the same terms when it writes the next share.
 */
export const SHARE_STALE_AFTER_MS = 60 * 60_000;

const SHARE_ID = /^(\d{1,16})-[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u;

/** A copied file's name in the share: its index and extension, never a path. */
const STORED_FILE = /^\d+(?:\.[\da-z]{1,10})?$/u;

/** Whether `value` names a share; anything else could reach outside the inbox. */
export const isShareId = (value: unknown): value is string =>
  typeof value === "string" && SHARE_ID.test(value);

/** When the share was made, read from its name; undefined for anything not a share. */
const shareCreatedAt = (name: string): number | undefined =>
  parseIntegerToken(SHARE_ID.exec(name)?.[1], { sign: "unsigned" }).unwrapOr(
    undefined,
  );

/**
 * The inbox entries to delete: shares older than `SHARE_STALE_AFTER_MS` and
 * anything not named as a share, but never `keep`, the share being opened.
 */
export const staleInboxEntries = ({
  keep,
  names,
  now,
}: {
  readonly keep: string | undefined;
  readonly names: readonly string[];
  readonly now: number;
}): readonly string[] =>
  names.filter((name) => {
    if (name === keep) {
      return false;
    }
    const created = shareCreatedAt(name);
    return created === undefined || now - created >= SHARE_STALE_AFTER_MS;
  });

const manifestSchema = v.pipe(
  v.string(),
  v.parseJson(),
  v.object({
    items: v.pipe(
      v.array(
        v.variant("type", [
          v.object({
            type: v.literal("file"),
            file: v.pipe(v.string(), v.regex(STORED_FILE)),
            name: v.pipe(v.string(), v.minLength(1)),
            mimeType: v.pipe(v.string(), v.minLength(1)),
          }),
          v.object({
            type: v.literal("link"),
            url: v.pipe(v.string(), v.url()),
          }),
          v.object({
            type: v.literal("text"),
            text: v.pipe(v.string(), v.minLength(1)),
          }),
        ]),
      ),
      v.minLength(1),
    ),
  }),
);

/** A shared file, at its place in the share's folder. */
export type SharedFile = {
  readonly type: "file";
  readonly id: string;
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string;
};

/**
 * One thing shared: a file, a web address, or text. `id` is its place in
 * the manifest, which never changes for a share.
 */
export type SharedItem =
  | SharedFile
  | { readonly type: "link"; readonly id: string; readonly url: string }
  | { readonly type: "text"; readonly id: string; readonly text: string };

/** The manifest's items, each file addressed inside `folderUri`. */
export const parseShareManifest = (
  manifest: string,
  folderUri: string,
): Result<readonly SharedItem[], SharedItemsError> => {
  const parsed = v.safeParse(manifestSchema, manifest);
  if (!parsed.success) {
    return Result.err(
      new SharedItemsError({
        message: "The share's manifest is not one the extension writes",
        cause: new v.ValiError(parsed.issues),
      }),
    );
  }
  const folder = folderUri.endsWith("/") ? folderUri : `${folderUri}/`;
  return Result.ok(
    parsed.output.items.map((item, position): SharedItem => {
      const id = String(position);
      switch (item.type) {
        case "file":
          return {
            type: "file",
            id,
            uri: `${folder}${item.file}`,
            name: item.name,
            mimeType: item.mimeType,
          };
        case "link":
          return { type: "link", id, url: item.url };
        case "text":
          return { type: "text", id, text: item.text };
        default:
          item satisfies never;
          return panic("The manifest schema admits only files, links and text");
      }
    }),
  );
};

/** Where a share can go: a matter keeps its files; a new chat takes everything. */
const SHARE_DESTINATIONS = ["matter", "chat"] as const;

export type ShareDestination = (typeof SHARE_DESTINATIONS)[number];

/** The destinations a share offers, never none; the first is chosen to begin with. */
export const shareDestinations = (
  items: readonly SharedItem[],
): readonly [ShareDestination, ...ShareDestination[]] =>
  items.some((item) => item.type === "file") ? SHARE_DESTINATIONS : ["chat"];

/** The shared files, in the order shared. */
export const sharedFiles = (
  items: readonly SharedItem[],
): readonly SharedFile[] => items.filter((item) => item.type === "file");

/** The shared files as the composer takes picked ones. */
export const sharedPickedFiles = (
  items: readonly SharedItem[],
): readonly PickedFile[] =>
  sharedFiles(items).map(({ mimeType, name, uri }) => ({
    mimeType,
    name,
    uri,
  }));

/** Links and text as a message's draft: one paragraph each, in the order shared. */
export const sharedDraftText = (items: readonly SharedItem[]): string =>
  items
    .flatMap((item) => {
      switch (item.type) {
        case "file":
          return [];
        case "link":
          return [item.url];
        case "text":
          return [item.text.trim()];
        default:
          item satisfies never;
          return panic("A shared item is a file, a link or text");
      }
    })
    .filter((paragraph) => paragraph !== "")
    .join("\n\n");
