import { describe, expect, test } from "bun:test";

import {
  CHAT_CELL_CITATION_HREF_PREFIX,
  parseChatCellCitationHref,
  replaceChatCellCitationHrefs,
  toChatCellCitationHref,
} from "./chat-cell-citation";
import { toSafeId } from "./safe-id";

const TARGET = {
  workspaceId: toSafeId<"workspace">("11111111-1111-4111-8111-111111111111"),
  entityId: toSafeId<"entity">("22222222-2222-4222-8222-222222222222"),
  propertyId: toSafeId<"property">("33333333-3333-4333-8333-333333333333"),
};

describe("chat cell citation links", () => {
  test("round-trips", () => {
    expect(parseChatCellCitationHref(toChatCellCitationHref(TARGET))).toEqual(
      TARGET,
    );
  });

  test("rejects anything but three uuids", () => {
    const { workspaceId, entityId, propertyId } = TARGET;
    for (const body of [
      "",
      `${workspaceId}:${entityId}`,
      `${workspaceId}:${entityId}:${propertyId}:x`,
      `${workspaceId}:ent_1:${propertyId}`,
      `${workspaceId}:${entityId}:prop_1`,
    ]) {
      expect(
        parseChatCellCitationHref(`${CHAT_CELL_CITATION_HREF_PREFIX}${body}`),
      ).toBeNull();
    }
  });

  test("replaces only well-formed links in text", () => {
    const href = toChatCellCitationHref(TARGET);
    const text = `[Halvorsen MSA · Cap](${href}) and [bad](${CHAT_CELL_CITATION_HREF_PREFIX}x)`;
    expect(replaceChatCellCitationHrefs(text, () => "#ok")).toBe(
      `[Halvorsen MSA · Cap](#ok) and [bad](${CHAT_CELL_CITATION_HREF_PREFIX}x)`,
    );
  });
});
