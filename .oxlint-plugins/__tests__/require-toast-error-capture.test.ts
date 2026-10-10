import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("reports uncaptured catch errors and unbound handlers", async () => {
  expect(
    await lintSingleRule(
      "require-toast-error-capture",
      'try { work(); } catch (error) {\n stellaToast.error("Failed");\n}\ntry { work(); } catch {\n stellaToast.add({ type: "error" });\n}',
      {},
    ),
  ).toEqual([1, 4]);
});

test("reports uncaptured promise and Result failures", async () => {
  expect(
    await lintSingleRule(
      "require-toast-error-capture",
      'work().catch((error) => { stellaToast.error("Failed"); });\nif (result.isErr()) { stellaToast.update({ type: "error" }); }',
      {},
    ),
  ).toEqual([1, 2]);
});

test("accepts captured failure owners including wrapped errors", async () => {
  expect(
    await lintSingleRule(
      "require-toast-error-capture",
      'try { work(); } catch (error) { analytics.captureError(toAPIError(error)); stellaToast.error("Failed"); }\nwork().catch((error) => { getAnalytics().captureError(error); stellaToast.error("Failed"); });\nif (result.isErr()) { captureError(result.error); stellaToast.error("Failed"); }',
      {},
    ),
  ).toEqual([]);
});

test("requires capture of the actual caught binding", async () => {
  expect(
    await lintSingleRule(
      "require-toast-error-capture",
      'try { work(); } catch (error) { captureError(other); stellaToast.error("Failed"); }',
      {},
    ),
  ).toEqual([1]);
});

test("assigns nested handlers their own capture responsibility", async () => {
  expect(
    await lintSingleRule(
      "require-toast-error-capture",
      'try { work(); } catch (outer) {\n captureError(outer);\n work().catch((inner) => { stellaToast.error("Failed"); });\n}',
      {},
    ),
  ).toEqual([3]);
});

test("allows handlers without an error toast", async () => {
  expect(
    await lintSingleRule(
      "require-toast-error-capture",
      'try { work(); } catch (error) { stellaToast.info("Retry"); }\nwork().catch(() => recover());',
      {},
    ),
  ).toEqual([]);
});
