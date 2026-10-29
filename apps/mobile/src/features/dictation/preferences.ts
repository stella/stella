import { Result, TaggedError } from "better-result";
import * as v from "valibot";

export type DictationAction = "export" | "save-to-matter";
const audioChoiceSchema = v.object({
  content: v.literal("audio"),
  cleaned: v.boolean(),
});
export type AudioChoice = v.InferOutput<typeof audioChoiceSchema>;
const CHOICE_KEYS = {
  export: "stella.dictation.export",
  "save-to-matter": "stella.dictation.save-to-matter",
} as const satisfies Record<DictationAction, string>;

export class DictationPreferenceError extends TaggedError(
  "DictationPreferenceError",
)<{
  message: string;
  cause: unknown;
}> {}

type PreferenceStore = {
  read: (key: string) => Promise<string | null>;
  write: (key: string, value: string) => Promise<void>;
};

export const dictationPreferences = (store: PreferenceStore) => ({
  loadChoice: async (
    action: DictationAction,
  ): Promise<Result<AudioChoice, DictationPreferenceError>> =>
    await Result.tryPromise({
      try: async () => {
        const stored = await store.read(CHOICE_KEYS[action]);
        return stored === null
          ? { content: "audio", cleaned: false }
          : v.parse(
              v.pipe(v.string(), v.parseJson(), audioChoiceSchema),
              stored,
            );
      },
      catch: (cause) =>
        new DictationPreferenceError({
          message: "Audio choices could not be read",
          cause,
        }),
    }),
  rememberChoice: async (
    action: DictationAction,
    choice: AudioChoice,
  ): Promise<Result<void, DictationPreferenceError>> =>
    await Result.tryPromise({
      try: async () => {
        await store.write(CHOICE_KEYS[action], JSON.stringify(choice));
      },
      catch: (cause) =>
        new DictationPreferenceError({
          message: "Audio choices could not be saved",
          cause,
        }),
    }),
});
