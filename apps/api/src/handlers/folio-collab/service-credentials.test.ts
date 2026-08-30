import { describe, expect, test } from "bun:test";

import { toFolioCollabServiceAuthorization } from "./service-credentials";

describe("collaboration service authorization", () => {
  test.each([
    { access: { status: "disabled" }, expectedStatus: 404 },
    { access: { status: "unauthorized" }, expectedStatus: 401 },
  ])(
    "maps $access.status access to $expectedStatus",
    ({ access, expectedStatus }) => {
      const result = toFolioCollabServiceAuthorization(access);

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.status).toBe(expectedStatus);
      }
    },
  );

  test("accepts an authorized service credential", () => {
    expect(
      toFolioCollabServiceAuthorization({ status: "authorized" }).status,
    ).toBe("ok");
  });
});
