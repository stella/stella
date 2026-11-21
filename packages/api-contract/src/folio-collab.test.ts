import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  folioCollabSnapshotLoadResponseSchema,
  parseFolioCollabRoomName,
  toFolioCollabRoomName,
} from "./folio-collab";
import type { FolioCollabSnapshotLoadResponse } from "./folio-collab";
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

test("snapshot reset responses require the generation actually reset and no update", () => {
  const reset = {
    loadOutcome: "rematerialize-from-docx",
    generation: 4,
    resetGeneration: 3,
    snapshotBase64: null,
    snapshotRevision: 5,
  } satisfies FolioCollabSnapshotLoadResponse;
  expect(v.parse(folioCollabSnapshotLoadResponseSchema, reset)).toEqual(reset);
  const { resetGeneration, ...withoutResetGeneration } = reset;
  expect(
    v.safeParse(folioCollabSnapshotLoadResponseSchema, withoutResetGeneration)
      .success,
  ).toBeFalse();
  expect(
    v.safeParse(folioCollabSnapshotLoadResponseSchema, {
      ...reset,
      snapshotBase64: "AQ==",
    }).success,
  ).toBeFalse();
  expect(
    v.safeParse(folioCollabSnapshotLoadResponseSchema, {
      ...reset,
      loadOutcome: "loaded",
    }).success,
  ).toBeFalse();
  expect(resetGeneration).toBe(3);
});
