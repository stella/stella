import { Result, TaggedError } from "better-result";

class SourceFileUnavailableError extends TaggedError(
  "SourceFileUnavailableError",
)<{
  message: string;
}> {}

type OpenSourceFileArgs = {
  load: () => Promise<{
    fields: readonly { id: string; content: { type: string } }[];
  }>;
  navigate: (fieldId: string) => Promise<void>;
};

export const openSourceFile = async ({
  load,
  navigate,
}: OpenSourceFileArgs) => {
  const loaded = await Result.tryPromise(load);
  if (Result.isError(loaded)) {
    return loaded;
  }
  const file = loaded.value.fields.find(
    (field) => field.content.type === "file",
  );
  if (file === undefined) {
    return Result.err(
      new SourceFileUnavailableError({
        message: "Source document has no file",
      }),
    );
  }
  return await Result.tryPromise(async () => await navigate(file.id));
};
