import { describe, expect, test } from "bun:test";

import {
  parseFolioCollabRoomName,
  toFolioCollabRoomName,
} from "./folio-collab";
import { toSafeId } from "./safe-id";

const ROOM_ID = toSafeId<"folioCollabRoom">(
  "01993f60-b9d0-7000-8000-000000000001",
);

describe("Folio collaboration room names", () => {
  test("round trips a room UUID through its Redis hashtag", () => {
    const roomName = toFolioCollabRoomName(ROOM_ID);

    expect(roomName).toBe(`{${ROOM_ID}}`);
    expect(parseFolioCollabRoomName(roomName)).toBe(ROOM_ID);
  });

  test.each([
    ROOM_ID,
    "{}",
    "{not-a-uuid}",
    `{${ROOM_ID.toUpperCase()}}`,
    `{${ROOM_ID}}:other`,
    `prefix:{${ROOM_ID}}`,
  ])("rejects non-canonical room name %s", (roomName) => {
    expect(parseFolioCollabRoomName(roomName)).toBeNull();
  });
});
