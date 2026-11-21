import { expect, test } from "bun:test";

import {
  formattedArtifactsLikeRepository,
  formattedLikeRepository,
} from "./generated-artifacts.ts";

test("formats every artifact by extension while preserving order and paths", async () => {
  const artifacts = [
    { path: "first/output.md", contents: "# First\n\n\ntext\n" },
    { path: "second/output.md", contents: "# Second\n\n\nother\n" },
    { path: "output.json", contents: '{"answer":42}' },
    { path: "output.ts", contents: "export const answer=42" },
  ];
  const expected = [
    { path: "first/output.md", contents: "# First\n\ntext\n" },
    { path: "second/output.md", contents: "# Second\n\nother\n" },
    { path: "output.json", contents: '{ "answer": 42 }\n' },
    { path: "output.ts", contents: "export const answer = 42;\n" },
  ];
  expect(artifacts).not.toEqual(expected);
  const formatted = await formattedArtifactsLikeRepository(artifacts);
  expect(formatted).toEqual(expected);
  expect(await formattedArtifactsLikeRepository(formatted)).toEqual(formatted);
});

test("formats an empty artifact batch", async () => {
  expect(await formattedArtifactsLikeRepository([])).toEqual([]);
});

test("single-file generators retain repository formatting", async () => {
  expect(await formattedLikeRepository("export const answer=42", "ts")).toBe(
    "export const answer = 42;\n",
  );
});
