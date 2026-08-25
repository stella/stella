import { describe, expect, test } from "bun:test";

import type { BrowserControlCommand } from "@stll/api-contract/browser-control";

import { getBrowserApprovalDetails } from "./browser-approval-summary";

describe("browser action approval summary", () => {
  test("shows the exact website and human-readable click target", () => {
    const command = {
      action: "click",
      page: { revision: "revision-1", url: "https://example.com/cases" },
      target: { name: "Open case 2026-42", ref: "e:0.1", role: "link" },
    } satisfies BrowserControlCommand;

    expect(getBrowserApprovalDetails(command)).toEqual([
      { type: "website", value: "https://example.com/cases" },
      { type: "target", value: "Open case 2026-42 (link)" },
    ]);
  });

  test("shows values and keys before approval", () => {
    const page = { revision: "revision-1", url: "https://example.com/search" };
    const target = { name: "Search", ref: "e:0.2", role: "textbox" };
    expect(
      getBrowserApprovalDetails({
        action: "fill",
        page,
        target,
        value: "confidentiality",
      }),
    ).toContainEqual({ type: "value", value: "confidentiality" });
    expect(
      getBrowserApprovalDetails({
        action: "press-key",
        key: "Enter",
        page,
        target,
      }),
    ).toContainEqual({ type: "key", value: "Enter" });
  });
});
