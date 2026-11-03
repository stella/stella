import { describe, expect, test } from "bun:test";

import {
  deriveDataBoxDirectionBasis,
  DIRECTION_BY_BASIS,
} from "@/api/lib/email/correspondence/data-box/direction";
import { readCorrespondenceChannel } from "@/api/lib/email/correspondence/provenance";

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

const statedEnvelope = {
  messageId: "1234567890",
  messageType: null,
  sender: {
    boxId: ORGANIZATION_BOX,
    name: null,
    address: null,
    referenceNumber: null,
    fileMark: null,
  },
  recipient: {
    boxId: COURT_BOX,
    name: null,
    address: null,
    referenceNumber: null,
    fileMark: null,
  },
  toHands: null,
  personalDelivery: null,
  substituteDelivery: null,
  deliveredAt: null,
  acceptedAt: null,
  status: null,
  seal: {
    status: "unverified",
    signerName: null,
    issuerName: null,
    serialNumber: null,
    signedAt: null,
  },
} as const;

const memberships = [
  { boxes: [], basis: "unknown", direction: "in" },
  { boxes: [ORGANIZATION_BOX], basis: "organization_sender", direction: "out" },
  { boxes: [COURT_BOX], basis: "organization_recipient", direction: "in" },
  { boxes: [ORGANIZATION_BOX, COURT_BOX], basis: "unknown", direction: "in" },
] as const;

describe("current-settings correspondence projection", () => {
  test.each(memberships)(
    "projects current membership $basis without modifying stored assertions",
    ({ boxes, basis, direction }) => {
      const stored = {
        channel: "data_box",
        dataBox: statedEnvelope,
        direction: null,
      } as const;
      const projected = readCorrespondenceChannel(stored, boxes);
      expect(projected).toEqual({
        channel: "data_box",
        dataBox: { ...statedEnvelope, directionBasis: basis },
        direction,
      });
      expect(stored.dataBox).not.toHaveProperty("directionBasis");
      expect(stored.direction).toBeNull();
    },
  );

  test.each(["in", "out"] as const)(
    "retains email direction %s",
    (direction) => {
      const stored = { channel: "email", dataBox: null, direction } as const;
      expect(readCorrespondenceChannel(stored, [ORGANIZATION_BOX])).toEqual(
        stored,
      );
    },
  );

  test("refuses stored derived metadata and missing email direction", () => {
    expect(() =>
      readCorrespondenceChannel(
        { channel: "data_box", dataBox: statedEnvelope, direction: "in" },
        [],
      ),
    ).toThrow("invalid stored metadata");
    const storedDerivedEnvelope = {
      ...statedEnvelope,
      directionBasis: "organization_sender",
    };
    expect(() =>
      readCorrespondenceChannel(
        {
          channel: "data_box",
          dataBox: storedDerivedEnvelope,
          direction: null,
        },
        [],
      ),
    ).toThrow("invalid stored metadata");
    expect(() =>
      readCorrespondenceChannel(
        { channel: "email", dataBox: null, direction: null },
        [],
      ),
    ).toThrow("invalid channel metadata");
  });
});
