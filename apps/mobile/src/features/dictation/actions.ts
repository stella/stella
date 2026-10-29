import { Result, TaggedError } from "better-result";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import type { ApiError } from "@/state/api-request";
import { readFileProperty, uploadDocument } from "@/state/document-upload";

export class DictationActionError extends TaggedError("DictationActionError")<{
  message: string;
  cause: unknown;
}> {}

type AudioFile = { uri: string; size: number; sha256Hex: string };
type AudioExport = (id: string, cleaned: boolean) => Promise<AudioFile>;
type ExportOptions = {
  draftId: string;
  cleaned: boolean;
  exportAudio: AudioExport;
  shareAudio: (uri: string) => Promise<boolean>;
};

export const exportDictation = async ({
  draftId,
  cleaned,
  exportAudio,
  shareAudio,
}: ExportOptions): Promise<Result<boolean, DictationActionError>> =>
  await Result.tryPromise({
    try: async () => {
      const file = await exportAudio(draftId, cleaned);
      return await shareAudio(file.uri);
    },
    catch: (cause) =>
      new DictationActionError({ message: "Audio export failed", cause }),
  });

type SaveOptions = Omit<ExportOptions, "shareAudio"> & {
  fetch: Fetch;
  source: AccessTokenSource;
  matterId: string;
  name: string;
};

// Completing an action never removes its source; deletion is a separate, explicit choice.
export const saveDictationToMatter = async ({
  draftId,
  cleaned,
  exportAudio,
  fetch,
  source,
  matterId,
  name,
}: SaveOptions): Promise<Result<string, ApiError | DictationActionError>> =>
  await Result.gen(async function* () {
    const file = yield* Result.await(
      Result.tryPromise({
        try: async () => await exportAudio(draftId, cleaned),
        catch: (cause) =>
          new DictationActionError({ message: "Audio export failed", cause }),
      }),
    );
    const propertyId = yield* Result.await(
      readFileProperty({ fetch, matterId, source }),
    );
    const trimmed = name.trim();
    return await uploadDocument({
      fetch,
      source,
      matterId,
      propertyId,
      name: trimmed.toLocaleLowerCase().endsWith(".m4a")
        ? trimmed
        : `${trimmed}.m4a`,
      file: { ...file, mimeType: "audio/mp4" },
    });
  });
