import { describe, expect, mock, test } from "bun:test";

import {
  isVerifiedOfficeCitationTarget,
  registerOfficeCitationNavigation,
  requestOfficeCitationNavigation,
  type OfficeCitationNavigation,
} from "@/lib/files/office-citations";

const navigation = {
  locator: {
    type: "xlsx",
    range: "B4:D4",
    sheetIndex: 1,
    sheetName: "Schedule",
  },
  target: {
    blockId: "xlsx-0123456789abcdef",
    entityId: "00000000-0000-4000-8000-000000000051",
    fieldId: "00000000-0000-4000-8000-000000000052",
  },
} as const satisfies OfficeCitationNavigation;

describe("Office citation navigation", () => {
  test("queues a verified locator until its exact viewer registers", async () => {
    const navigate = mock(() => undefined);
    requestOfficeCitationNavigation(navigation);

    const unregister = registerOfficeCitationNavigation({
      entityId: navigation.target.entityId,
      fieldId: navigation.target.fieldId,
      navigate,
    });
    await Promise.resolve();

    expect(navigate).toHaveBeenCalledWith(navigation);
    unregister();
  });

  test("rejects a source whose entity or field differs from the href", () => {
    expect(
      isVerifiedOfficeCitationTarget({
        source: {
          entityId: navigation.target.entityId,
          fieldId: navigation.target.fieldId,
        },
        target: navigation.target,
      }),
    ).toBe(true);
    expect(
      isVerifiedOfficeCitationTarget({
        source: {
          entityId: navigation.target.entityId,
          fieldId: "00000000-0000-4000-8000-000000000099",
        },
        target: navigation.target,
      }),
    ).toBe(false);
  });
});
