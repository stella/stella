import { describe, expect, test } from "bun:test";

import { parsePickedEntityIdsJson } from "./safe-id-boundaries";

const UUID_A = "0196d7a8-1111-7777-8888-0123456789ab";
const UUID_B = "0196d7a8-2222-7777-8888-0123456789ab";

describe("parsePickedEntityIdsJson", () => {
  test("parses a JSON array of uuids", () => {
    expect(parsePickedEntityIdsJson(`["${UUID_A}", "${UUID_B}"]`, 5)).toEqual([
      UUID_A,
      UUID_B,
    ]);
  });

  test("accepts an empty array", () => {
    expect(parsePickedEntityIdsJson("[]", 5)).toEqual([]);
  });

  test("rejects malformed JSON", () => {
    expect(parsePickedEntityIdsJson("not json", 5)).toBeNull();
  });

  test("rejects non-array JSON", () => {
    expect(parsePickedEntityIdsJson(`{"id": "${UUID_A}"}`, 5)).toBeNull();
    expect(parsePickedEntityIdsJson(`"${UUID_A}"`, 5)).toBeNull();
  });

  test("rejects arrays over the limit", () => {
    expect(
      parsePickedEntityIdsJson(`["${UUID_A}", "${UUID_B}"]`, 1),
    ).toBeNull();
  });

  test("rejects non-uuid members", () => {
    expect(parsePickedEntityIdsJson(`["${UUID_A}", "nope"]`, 5)).toBeNull();
    expect(parsePickedEntityIdsJson(`["${UUID_A}", 42]`, 5)).toBeNull();
  });
});
