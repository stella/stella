import { Result, TaggedError } from "better-result";

import type { BeforeSessionEnd } from "@/connection/session-end";
import type {
  DictationRecorder,
  DraftScope,
} from "@/native/dictation-recorder";

export class DictationSuspensionError extends TaggedError(
  "DictationSuspensionError",
)<{
  message: string;
  cause: unknown;
}> {}

type SessionEndHandlerOptions = {
  recorderFor: (scope: DraftScope) => Pick<DictationRecorder, "suspend">;
  onFailure: (error: DictationSuspensionError) => void;
};

export const dictationSessionEndHandler =
  ({ recorderFor, onFailure }: SessionEndHandlerOptions): BeforeSessionEnd =>
  async (_reason, session) => {
    const result = await Result.tryPromise({
      try: async () =>
        await recorderFor({
          serverOrigin: new URL(session.serverUrl).origin,
          userId: session.userId,
        }).suspend(),
      catch: (cause) =>
        new DictationSuspensionError({
          message: "The recording could not be suspended",
          cause,
        }),
    });
    if (Result.isError(result)) {
      onFailure(result.error);
    }
  };
