import { afterEach, expect, test } from "bun:test";

import {
  hasActiveUpload,
  resetActiveUploadsForTests,
  retainActiveUpload,
} from "@/lib/uploads/active-uploads";

afterEach(() => {
  resetActiveUploadsForTests();
});

test("overlapping upload batches stay active until each one releases", () => {
  const releaseFirst = retainActiveUpload();
  const releaseSecond = retainActiveUpload();
  expect(hasActiveUpload()).toBe(true);

  releaseFirst();
  releaseFirst();
  expect(hasActiveUpload()).toBe(true);

  releaseSecond();
  expect(hasActiveUpload()).toBe(false);
});
