import { Result, TaggedError, type TaggedErrorClass } from "better-result";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

type WriteGeneratedFileOptions = {
  output: URL;
  content: string;
  write?: (path: string, content: string) => Promise<void>;
};

const GeneratedFileWriteErrorBase: TaggedErrorClass<"GeneratedFileWriteError"> =
  TaggedError("GeneratedFileWriteError");
class GeneratedFileWriteError extends GeneratedFileWriteErrorBase<{
  message: string;
  output: string;
  cause: unknown;
}> {}

export const writeGeneratedFile = async ({
  output,
  content,
  write = writeFile,
}: WriteGeneratedFileOptions): Promise<
  Result<undefined, GeneratedFileWriteError>
> => {
  const previous = await Result.tryPromise({
    try: async () => await readFile(output, "utf-8"),
    catch: (cause) => cause,
  });
  if (Result.isOk(previous) && previous.value === content) {
    return Result.ok(undefined);
  }
  if (
    Result.isError(previous) &&
    !(
      previous.error instanceof Error &&
      "code" in previous.error &&
      previous.error.code === "ENOENT"
    )
  ) {
    return Result.err(
      new GeneratedFileWriteError({
        message: `Cannot read generated file ${output.pathname}: ${String(previous.error)}`,
        output: output.href,
        cause: previous.error,
      }),
    );
  }

  // Sibling files keep rename atomic; unique names isolate concurrent writers.
  const temporary = `${fileURLToPath(output)}.${randomUUID()}.tmp`;
  const replaced = await Result.tryPromise({
    try: async () => {
      await write(temporary, content);
      await rename(temporary, output);
      return undefined;
    },
    catch: (cause) =>
      new GeneratedFileWriteError({
        message: `Cannot replace generated file ${output.pathname}: ${String(cause)}`,
        output: output.href,
        cause,
      }),
  });
  const cleaned = await Result.tryPromise({
    try: async () => {
      await rm(temporary, { force: true });
      return undefined;
    },
    catch: (cause) =>
      new GeneratedFileWriteError({
        message: `Cannot clean generated file ${output.pathname}: ${String(cause)}`,
        output: output.href,
        cause,
      }),
  });
  if (Result.isError(replaced)) {
    return replaced;
  }
  return cleaned;
};
