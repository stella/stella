import { describe, expect, test } from "bun:test";

import { openedTabVerdict } from "./opened-tabs";

describe("tabs a controlled page opens", () => {
  test("waits while the tab has not chosen a visible address", () => {
    for (const tab of [
      {},
      { url: "" },
      { url: "about:blank" },
      { pendingUrl: "about:blank", url: "" },
    ]) {
      expect(openedTabVerdict(tab)).toBe("pending");
    }
  });

  test("closes a tab aimed outside the public HTTPS policy", () => {
    for (const url of [
      "https://printer.local/popup",
      "https://192.168.1.1/",
      "https://app.stll.app/chat",
    ]) {
      expect(openedTabVerdict({ pendingUrl: url, url: "" })).toBe("refused");
    }
  });

  test("keeps a public page, judging the pending address first", () => {
    expect(
      openedTabVerdict({
        pendingUrl: "https://example.com/next",
        url: "about:blank",
      }),
    ).toBe("allowed");
    expect(
      openedTabVerdict({
        pendingUrl: "https://10.0.0.1/",
        url: "https://example.com/",
      }),
    ).toBe("refused");
  });
});
