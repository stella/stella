import { afterEach, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  hasActiveUpload,
  resetActiveUploadsForTests,
  retainActiveUpload,
  withActiveUpload,
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

test("an upload counts while it runs and releases when it fails", async () => {
  const pending = Promise.withResolvers<never>();
  const upload = withActiveUpload(async () => await pending.promise);
  expect(hasActiveUpload()).toBe(true);

  pending.reject(new Error("network"));
  expect(await rejectionOf(upload)).toBeInstanceOf(Error);
  expect(hasActiveUpload()).toBe(false);
});
