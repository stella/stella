import { describe, expect, test } from "bun:test";

import { readFailureBrand } from "@stll/errors";

import {
  gradedDocumentFetchBudget,
  startDocumentFetchBudget,
} from "@/api/lib/legal-search/document-fetch-budget";

const expiryOf = async (budget: AbortSignal): Promise<unknown> => {
  if (!budget.aborted) {
    await new Promise<void>((resolve) => {
      budget.addEventListener(
        "abort",
        () => {
          resolve();
        },
        { once: true },
      );
    });
  }
  return budget.reason;
};

describe("document fetch budget", () => {
  test("a started budget grades its expiry as the publisher being slow", async () => {
    const reason = await expiryOf(startDocumentFetchBudget(1));
    expect(readFailureBrand(reason)?.reason).toBe("upstream_unavailable");
  });

  test("a budget derived from a fetch's own signal grades its expiry the same way", async () => {
    const reason = await expiryOf(
      AbortSignal.any([
        startDocumentFetchBudget(1),
        new AbortController().signal,
      ]),
    );
    expect(readFailureBrand(reason)?.reason).toBe("upstream_unavailable");
  });

  test("a bare timeout carries no grade", async () => {
    const reason = await expiryOf(AbortSignal.timeout(1));
    expect(readFailureBrand(reason)).toBeUndefined();
  });

  test("an abort the budget did not cause keeps its own reason", async () => {
    const controller = new AbortController();
    const budget = gradedDocumentFetchBudget(controller.signal);
    const cause = new Error("caller cancelled");
    controller.abort(cause);
    expect(await expiryOf(budget)).toBe(cause);
  });
});
