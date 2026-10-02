import { Result } from "better-result";
import { expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { writeGeneratedFile } from "./write-generated-file";

test("concurrent replacements leave the live module complete during partial writes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cli-generated-write-"));
  const target = path.join(directory, "module.ts");
  const original = 'export const value = "original";\n';
  const contents = ["first", "second"].map(
    (value) => `export const value = "${value.repeat(1024)}";\n`,
  );
  const partials = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let partialCount = 0;
  const write = async (temporary: string, content: string) => {
    expect(path.dirname(temporary)).toBe(directory);
    await writeFile(temporary, content.slice(0, content.length / 2));
    partialCount += 1;
    if (partialCount === contents.length) {
      partials.resolve(undefined);
    }
    await release.promise;
    await writeFile(temporary, content);
  };
  await writeFile(target, original);
  const writes = contents.map(async (content) => {
    const result = await writeGeneratedFile({
      output: pathToFileURL(target),
      content,
      write,
    });
    expect(Result.isOk(result)).toBe(true);
  });
  try {
    await partials.promise;
    expect(await readFile(target, "utf-8")).toBe(original);
  } finally {
    release.resolve(undefined);
    await Promise.all(writes);
    const completed = await readFile(target, "utf-8");
    expect(contents).toContain(completed);
    expect(await readdir(directory)).toEqual(["module.ts"]);
    await rm(directory, { recursive: true });
  }
});

test("unchanged generated content preserves the file without writing", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cli-generated-unchanged-"),
  );
  const target = path.join(directory, "module.ts");
  const content = "export const value = 1;\n";
  try {
    await writeFile(target, content);
    const before = await stat(target);
    let writes = 0;
    const result = await writeGeneratedFile({
      output: pathToFileURL(target),
      content,
      write: async (temporary, bytes) => {
        writes += 1;
        await writeFile(temporary, bytes);
      },
    });
    expect(Result.isOk(result)).toBe(true);
    expect(writes).toBe(0);
    const after = await stat(target);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(target, "utf-8")).toBe(content);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("a failed replacement returns a tagged error and preserves the live module", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cli-generated-failure-"),
  );
  const target = path.join(directory, "module.ts");
  const original = "export const value = 1;\n";
  try {
    await writeFile(target, original);
    const result = await writeGeneratedFile({
      output: pathToFileURL(target),
      content: "export const value = 2;\n",
      write: async (temporary, content) => {
        await writeFile(temporary, content.slice(0, 8));
        throw new TypeError("injected disk write failure");
      },
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error._tag).toBe("GeneratedFileWriteError");
      expect(result.error.message).toContain("injected disk write failure");
    }
    expect(await readFile(target, "utf-8")).toBe(original);
    expect(await readdir(directory)).toEqual(["module.ts"]);
  } finally {
    await rm(directory, { recursive: true });
  }
});
