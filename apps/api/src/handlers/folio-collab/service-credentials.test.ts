import { describe, expect, mock, test } from "bun:test";

void mock.module("@/api/env", () => ({
  env: { STELLA_COLLAB_SERVICE_TOKEN: undefined },
}));

const { toFolioCollabServiceAuthorization } =
  await import("./service-credentials");

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
