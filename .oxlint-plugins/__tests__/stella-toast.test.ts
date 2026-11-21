import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects raw Base UI toast integration", async () => {
  expect(
    await lintSingleRule(
      "stella-toast",
      'import { Toast } from "@base-ui/react/toast";',
    ),
  ).toEqual([1]);
});

test("rejects manager access through the toast module", async () => {
  expect(
    await lintSingleRule(
      "stella-toast",
      'import { toast, toastManager as manager } from "@stll/ui/toast";',
    ),
  ).toEqual([1, 1]);
});

test("rejects anchored managers through the grouped toast entry", async () => {
  expect(
    await lintSingleRule(
      "stella-toast",
      'import { AnchoredToastProvider, anchoredToastManager } from "@stll/ui/components/toast";',
    ),
  ).toEqual([1, 1]);
});

test("accepts the shared toast surface", async () => {
  expect(
    await lintSingleRule(
      "stella-toast",
      'import { stellaToast } from "@stll/ui/toast";\nstellaToast.success("Saved");',
    ),
  ).toEqual([]);
});

test("accepts unrelated providers", async () => {
  expect(
    await lintSingleRule(
      "stella-toast",
      'import { Provider } from "./notification-provider";',
    ),
  ).toEqual([]);
});
