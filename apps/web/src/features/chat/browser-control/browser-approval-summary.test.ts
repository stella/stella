import { describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_TARGET_METADATA,
  type BrowserControlCommand,
} from "@stll/api-contract/browser-control";

import { getBrowserApprovalDetails } from "./browser-approval-summary";

const ABSENT_TARGET_METADATA = {
  type: BROWSER_CONTROL_TARGET_METADATA.absent,
} as const;

describe("browser action approval summary", () => {
  test("shows the exact website, the click target and its link destination", () => {
    const command = {
      action: "click",
      page: { revision: "revision-1", url: "https://example.com/cases" },
      target: {
        context: {
          type: BROWSER_CONTROL_TARGET_METADATA.present,
          value: "2026-42 Smith v. Jones Open case 2026-42",
        },
        href: {
          type: BROWSER_CONTROL_TARGET_METADATA.present,
          value: "https://example.com/cases/2026-42",
        },
        name: "Open case 2026-42",
        ref: "e:0:0.1",
        role: "link",
      },
    } satisfies BrowserControlCommand;

    expect(getBrowserApprovalDetails(command)).toEqual([
      { type: "website", value: "https://example.com/cases" },
      { type: "target", value: "Open case 2026-42 (link)" },
      { type: "context", value: "2026-42 Smith v. Jones Open case 2026-42" },
      { type: "link", value: "https://example.com/cases/2026-42" },
    ]);
  });

  test("shows values and keys before approval", () => {
    const page = { revision: "revision-1", url: "https://example.com/search" };
    const target = {
      context: ABSENT_TARGET_METADATA,
      href: ABSENT_TARGET_METADATA,
      name: "Search",
      ref: "e:0:0.2",
      role: "textbox",
    };
    expect(
      getBrowserApprovalDetails({
        action: "fill",
        page,
        target,
        value: "confidentiality",
      }),
    ).toEqual([
      { type: "website", value: page.url },
      { type: "target", value: "Search (textbox)" },
      { type: "value", value: "confidentiality" },
    ]);
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
