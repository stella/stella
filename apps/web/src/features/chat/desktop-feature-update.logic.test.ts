import { expect, test } from "bun:test";
import { createTranslator } from "use-intl/core";

import type {
  ChatLocalRunnerReadiness,
  ChatLocalRunReadiness,
} from "@stll/api-contract/chat-run-target";

import messages from "@/i18n/langs/en.json";

import {
  DESKTOP_FEATURE_UPDATE_MESSAGES,
  desktopNeedsUpdateFor,
} from "./desktop-feature-update.logic";

const runner = (
  appVersion: string,
  connected = true,
): ChatLocalRunnerReadiness => ({
  desktopId: Bun.randomUUIDv7(),
  appVersion,
  connected,
  lastSeenAt: "2026-11-25T10:00:00.000Z",
  harnesses: [],
  linkedFolders: [],
});

const enabled = (
  ...runners: ChatLocalRunnerReadiness[]
): ChatLocalRunReadiness => ({
  status: "enabled",
  runners,
  maxApprovals: "full_auto",
});

test("a computer before website approvals is offered the update", () => {
  expect(
    desktopNeedsUpdateFor("browserSiteApprovals", enabled(runner("0.9.90"))),
  ).toBe(true);
  // Two connected computers, both too old: the run lands on one of them.
  expect(
    desktopNeedsUpdateFor(
      "browserSiteApprovals",
      enabled(runner("0.9.89"), runner("0.9.90")),
    ),
  ).toBe(true);
});

test("a computer new enough, or none connected, is offered nothing", () => {
  for (const readiness of [
    undefined,
    { status: "hidden", maxApprovals: "full_auto" } as const,
    enabled(),
    enabled(runner("0.9.91")),
    enabled(runner("0.10.0")),
    // A disconnected old computer runs nothing now.
    enabled(runner("0.9.90", false)),
    // A run may land on the new one.
    enabled(runner("0.9.90"), runner("0.9.91")),
    // A build made from a checkout, and a pre-release, are never too old.
    enabled(runner("0.0.1")),
    enabled(runner("0.9.92-rc.1")),
  ] satisfies (ChatLocalRunReadiness | undefined)[]) {
    expect(desktopNeedsUpdateFor("browserSiteApprovals", readiness)).toBe(
      false,
    );
  }
});

test("every feature names its update in the catalog", () => {
  const t = createTranslator({ locale: "en", messages });
  for (const key of Object.values(DESKTOP_FEATURE_UPDATE_MESSAGES)) {
    expect(t(key)).not.toBe(key);
  }
});
