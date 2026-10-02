import { Result } from "better-result";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

type WriteGeneratedFileOptions = {
  output: URL;
  content: string;
  write?: (path: string, content: string) => Promise<void>;
};

export const writeGeneratedFile = async ({
  output,
  content,
  write = writeFile,
}: WriteGeneratedFileOptions): Promise<void> => {
  const previous = await Result.tryPromise({
    try: async () => await readFile(output, "utf-8"),
    catch: (cause) => cause,
  });
  if (Result.isOk(previous) && previous.value === content) {
    return;
  }
  if (
    Result.isError(previous) &&
    !(
      previous.error instanceof Error &&
      "code" in previous.error &&
      previous.error.code === "ENOENT"
    )
  ) {
    throw previous.error;
  }

  // Sibling files keep rename atomic; unique names isolate concurrent writers.
  const temporary = `${fileURLToPath(output)}.${randomUUID()}.tmp`;
  const replaced = await Result.tryPromise(async () => {
    await write(temporary, content);
    await rename(temporary, output);
  });
  await rm(temporary, { force: true });
  if (Result.isError(replaced)) {
    throw replaced.error;
  }
};
