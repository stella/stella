import { Result } from "better-result";
import { readFile } from "node:fs/promises";

/** ID lists preserve first occurrence order, including across repeated flags. */
export const parseIds = async (
  values: readonly string[],
): Promise<Result<string[], string>> => {
  const ids = new Set<string>();
  for (const value of values) {
    let source = value;
    let separator = /,/u;
    if (value.startsWith("@")) {
      const file = await Result.tryPromise(
        async () => await readFile(value.slice(1), "utf-8"),
      );
      if (Result.isError(file)) {
        return Result.err(
          `Cannot read ID file ${value.slice(1)}: ${file.error.message}`,
        );
      }
      source = file.value;
      separator = /\r?\n/u;
    }
    for (const token of source.split(separator)) {
      const id = token.trim();
      if (id.length > 0) {
        ids.add(id);
      }
    }
  }
  return Result.ok([...ids]);
};
