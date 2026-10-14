import { describe, expect, test } from "bun:test";

import {
  deriveDataBoxDirectionBasis,
  DIRECTION_BY_BASIS,
} from "@/api/lib/data-box/direction";

const ORGANIZATION_BOX = "xyz9876";
const COURT_BOX = "abc2def";

describe("deriveDataBoxDirectionBasis", () => {
  test("a message from the organization's box is outgoing", () => {
    const basis = deriveDataBoxDirectionBasis({
      senderBoxId: ORGANIZATION_BOX,
      recipientBoxId: COURT_BOX,
      organizationBoxIds: [ORGANIZATION_BOX],
    });
    expect([basis, DIRECTION_BY_BASIS[basis]]).toEqual([
      "organization_sender",
      "out",
    ]);
  });

  test("a message to the organization's box is incoming", () => {
    const basis = deriveDataBoxDirectionBasis({
      senderBoxId: COURT_BOX,
      recipientBoxId: ORGANIZATION_BOX,
      organizationBoxIds: [ORGANIZATION_BOX],
    });
    expect([basis, DIRECTION_BY_BASIS[basis]]).toEqual([
      "organization_recipient",
      "in",
    ]);
  });

  test("neither or both boxes leave the direction unknown and incoming", () => {
    for (const organizationBoxIds of [
      [],
      ["qqq1111"],
      [ORGANIZATION_BOX, COURT_BOX],
    ]) {
      expect(
        deriveDataBoxDirectionBasis({
          senderBoxId: COURT_BOX,
          recipientBoxId: ORGANIZATION_BOX,
          organizationBoxIds,
        }),
      ).toBe("unknown");
    }
    expect(DIRECTION_BY_BASIS.unknown).toBe("in");
  });
});
