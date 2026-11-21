import { expect, test } from "bun:test";

import { createWindowReadCache } from "@/api/lib/files/window-read-cache";

test("window sources stay within their byte budget and evict least recently read values", () => {
  const cache = createWindowReadCache<string>({
    maxBytes: 300,
    sizeOf: (text) => text.length * 2,
  });
  cache.set("a", "first");
  cache.set("b", "second");
  expect(cache.get("a")).toBe("first");
  cache.set("c", "third");
  expect(cache.get("b")).toBeUndefined();
  expect(cache.get("a")).toBe("first");
  expect(cache.heldBytes()).toBeLessThanOrEqual(300);
  cache.set("oversized", "x".repeat(300));
  expect(cache.get("oversized")).toBeUndefined();
  for (let index = 0; index < 1000; index += 1) {
    cache.set(String(index), "");
    expect(cache.heldBytes()).toBeLessThanOrEqual(300);
  }
});
