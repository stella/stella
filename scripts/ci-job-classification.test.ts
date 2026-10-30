import { expect, test } from "bun:test";

import "./check-ci-job-classification.test";
import { CLASSIFICATION_INPUT_GLOBS } from "./ci-job-classification/inputs";

test("the classification entrypoint reaches its input contract", () => {
  expect(CLASSIFICATION_INPUT_GLOBS).toContain(".github/workflows/**");
});
