import { expect, test } from "bun:test";
import path from "node:path";

import { checkJobClassification } from "./check-ci-job-classification";

test("committed workflow classification metadata is current", () => {
  const result = checkJobClassification({
    root: path.resolve(import.meta.dir, ".."),
    mode: "check",
  });
  expect(result.isOk()).toBe(true);
  if (result.isErr()) {
    throw result.error;
  }
}, 90_000);
