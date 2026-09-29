import { Result } from "better-result";
import { expect, test } from "bun:test";

import { openSourceFile } from "@/components/workspaces/list-source.logic";

const fieldId = "0199a3c4-5b6d-7e8f-9a0b-000000000091";

test("a deleted source returns an error without navigating", async () => {
  const failure = new Error("Source document returned 404");
  let opened = false;
  const result = await openSourceFile({
    load: async () => {
      throw failure;
    },
    navigate: async () => {
      opened = true;
    },
  });
  expect(Result.isError(result)).toBe(true);
  expect(opened).toBe(false);
});

test("a source without a file returns an error without navigating", async () => {
  let opened = false;
  const result = await openSourceFile({
    load: async () => ({
      fields: [{ id: fieldId, content: { type: "text" } }],
    }),
    navigate: async () => {
      opened = true;
    },
  });
  expect(Result.isError(result)).toBe(true);
  expect(opened).toBe(false);
});

test("opens the source file and propagates navigation failures", async () => {
  for (const fail of [false, true]) {
    const opened: string[] = [];
    const result = await openSourceFile({
      load: async () => ({
        fields: [{ id: fieldId, content: { type: "file" } }],
      }),
      navigate: async (id) => {
        opened.push(id);
        if (fail) {
          throw new Error("Navigation failed");
        }
      },
    });
    expect(opened).toEqual([fieldId]);
    expect(Result.isError(result)).toBe(fail);
  }
});
