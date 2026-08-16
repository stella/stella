import { describe, expect, test } from "bun:test";

import { parseDevQuickStartAttempt } from "./dev-quick-start-storage";
import { DEV_QUICK_START_PHASE } from "./dev-quick-start.logic";

const STORED_ATTEMPT = {
  completedPhase: DEV_QUICK_START_PHASE.organization,
  identity: {
    email: "dev-quick-start@stella.dev",
    organizationName: "Harvey LAB 018F1F7E",
    organizationSlug: "dev-quick-start-018f1f7e",
    selectionSeed: "018f1f7e-89ab-7def-8123-456789abcdef",
  },
  organizationId: "organization-quick-start",
} as const;

describe("parseDevQuickStartAttempt", () => {
  test("restores the organization-pinned attempt after navigation", () => {
    expect(parseDevQuickStartAttempt(JSON.stringify(STORED_ATTEMPT))).toEqual(
      STORED_ATTEMPT,
    );
  });

  test("rejects stale progress without its organization binding", () => {
    const { organizationId: _organizationId, ...staleAttempt } = STORED_ATTEMPT;

    expect(parseDevQuickStartAttempt(JSON.stringify(staleAttempt))).toBeNull();
  });
});
