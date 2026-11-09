import { Result } from "better-result";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseIds } from "./ids.js";

test("ID lists trim whitespace, drop blanks, and retain first occurrence order", async () => {
  expect((await parseIds([" a, b,,a ", " c,b "])).unwrap()).toEqual([
    "a",
    "b",
    "c",
  ]);
});

test("ID files accept blank lines and CRLF and deduplicate across flags", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "stella-batch-ids-"));
  try {
    const file = path.join(directory, "ids.txt");
    await writeFile(file, "\r\n a \r\nb\r\na\r\n \r\n c\r\n");
    expect((await parseIds(["b", `@${file}`, "c,d"])).unwrap()).toEqual([
      "b",
      "a",
      "c",
      "d",
    ]);
    const missing = await parseIds([`@${path.join(directory, "missing")}`]);
    expect(Result.isError(missing)).toBe(true);
  } finally {
    await rm(directory, { recursive: true });
  }
});
