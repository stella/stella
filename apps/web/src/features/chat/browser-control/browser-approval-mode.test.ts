import { describe, expect, test } from "bun:test";

import type { BrowserControlCommand } from "@stll/api-contract/browser-control";

import {
  BROWSER_APPROVAL_MODE,
  browserApprovalModeAllows,
} from "./browser-approval-mode";

const read = { action: "snapshot" } satisfies BrowserControlCommand;
const act = {
  action: "click",
  page: { revision: "revision-1", url: "https://example.com/" },
  target: { name: "Submit", ref: "e:0:0.1", role: "button" },
} satisfies BrowserControlCommand;

describe("browser approval mode", () => {
  test("asks for everything by default", () => {
    expect(
      browserApprovalModeAllows(BROWSER_APPROVAL_MODE.askEveryTime, read),
    ).toBe(false);
    expect(
      browserApprovalModeAllows(BROWSER_APPROVAL_MODE.askEveryTime, act),
    ).toBe(false);
  });

  test("auto-approves only reads in the reads mode", () => {
    expect(
      browserApprovalModeAllows(BROWSER_APPROVAL_MODE.autoApproveReads, read),
    ).toBe(true);
    expect(
      browserApprovalModeAllows(BROWSER_APPROVAL_MODE.autoApproveReads, {
        action: "go-back",
      }),
    ).toBe(true);
    expect(
      browserApprovalModeAllows(BROWSER_APPROVAL_MODE.autoApproveReads, act),
    ).toBe(false);
    expect(
      browserApprovalModeAllows(BROWSER_APPROVAL_MODE.autoApproveReads, {
        action: "open",
        url: "https://example.com/",
      }),
    ).toBe(false);
  });

  test("auto-approves everything in the all mode", () => {
    expect(
      browserApprovalModeAllows(BROWSER_APPROVAL_MODE.autoApproveAll, act),
    ).toBe(true);
  });
});
