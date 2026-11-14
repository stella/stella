import { panic, Result } from "better-result";
import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";

import { SHARE_INBOX } from "@/env";
import {
  isShareId,
  parseShareManifest,
  SHARE_MANIFEST,
  SharedItemsError,
  staleInboxEntries,
} from "@/state/shared-items";
import type { SharedItem } from "@/state/shared-items";

/**
 * The App Group folder the share extension writes into, or an error where
 * the build has no extension (Android, or a release that leaves it out).
 */
const inbox = (): Result<Directory, SharedItemsError> => {
  if (Platform.OS !== "ios" || SHARE_INBOX === null) {
    return Result.err(
      new SharedItemsError({ message: "This build takes no shares" }),
    );
  }
  // The app config grants the App Group whenever it declares the inbox.
  const container =
    Paths.appleSharedContainers[SHARE_INBOX.appGroup] ??
    panic(`The build lacks the App Group ${SHARE_INBOX.appGroup}`);
  return Result.ok(new Directory(container, SHARE_INBOX.folder));
};

const shareFolder = (shareId: string): Result<Directory, SharedItemsError> =>
  isShareId(shareId)
    ? inbox().map((folder) => new Directory(folder, shareId))
    : Result.err(new SharedItemsError({ message: "Not a share" }));

/** What the share holds, each file addressed where the extension copied it. */
export const readShare = async (
  shareId: string,
): Promise<Result<readonly SharedItem[], SharedItemsError>> => {
  const folder = shareFolder(shareId);
  if (Result.isError(folder)) {
    return folder;
  }
  const manifest = await Result.tryPromise({
    try: async () => await new File(folder.value, SHARE_MANIFEST).text(),
    catch: (cause) =>
      new SharedItemsError({
        message: "The share is gone, or was never finished",
        cause,
      }),
  });
  return Result.isError(manifest)
    ? manifest
    : parseShareManifest(manifest.value, folder.value.uri);
};

/** Deletes the share and every file in it; a share already gone is not an error. */
export const discardShare = (shareId: string): Result<void, SharedItemsError> =>
  shareFolder(shareId).andThen((folder) =>
    Result.try({
      try: () => {
        if (folder.exists) {
          folder.delete();
        }
      },
      catch: (cause) =>
        new SharedItemsError({
          message: "The share could not be deleted",
          cause,
        }),
    }),
  );

/**
 * Deletes every share the app never took within the hour, and anything
 * else left in the inbox, but not `keep`, the share being opened.
 */
export const sweepShares = ({
  keep,
  now,
}: {
  readonly keep: string | undefined;
  readonly now: number;
}): Result<void, SharedItemsError> =>
  inbox().andThen((folder) =>
    Result.try({
      try: () => {
        if (!folder.exists) {
          return;
        }
        const entries = folder.list();
        const stale = new Set(
          staleInboxEntries({
            keep,
            names: entries.map((entry) => entry.name),
            now,
          }),
        );
        for (const entry of entries) {
          if (stale.has(entry.name)) {
            entry.delete();
          }
        }
      },
      catch: (cause) =>
        new SharedItemsError({
          message: "Old shares could not be deleted",
          cause,
        }),
    }),
  );
