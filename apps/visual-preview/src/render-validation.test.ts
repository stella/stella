import { Result } from "better-result";
import { expect, test } from "bun:test";

import { renderVisual } from "./render";

test("rejects UTF-8 documents beyond the shared bound before launching", async () => {
  const result = await renderVisual({
    input: { document: "€".repeat(800_000), viewport: { width: 1200 } },
    launch: async () => {
      throw new Error("Browser must not launch");
    },
  });
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error.message).toBe("Invalid preview input");
  }
});
