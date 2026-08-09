import { describe, expect, test } from "bun:test";

import { parsePersistedDocxOperation } from "./operation-payload";

describe("parsePersistedDocxOperation", () => {
  test("accepts a Folio operation payload", () => {
    expect(
      parsePersistedDocxOperation({
        id: "op-1",
        type: "replaceInBlock",
        blockId: "block-1",
        find: "old",
        replace: "new",
      }),
    ).toMatchObject({ type: "replaceInBlock", id: "op-1" });
  });

  test("rejects malformed persisted payloads", () => {
    expect(parsePersistedDocxOperation(null)).toBeNull();
    expect(
      parsePersistedDocxOperation({
        id: "op-1",
        type: "replaceInBlock",
        blockId: "block-1",
        find: 7,
        replace: "new",
      }),
    ).toBeNull();
  });
});
