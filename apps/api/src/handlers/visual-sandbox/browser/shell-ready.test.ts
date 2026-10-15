import { describe, expect, test } from "bun:test";

import { visualShellReadyMessage } from "./shell-ready";

const nonce = "00000000-0000-4000-8000-000000000001";
describe("visual shell readiness", () => {
  test("reads its nonce only from a valid fragment", () => {
    expect(visualShellReadyMessage(`#n=${nonce}`)).toEqual({
      kind: "shell-ready",
      nonce,
    });
    for (const fragment of ["", "#n=short", "#other=value"]) {
      expect(visualShellReadyMessage(fragment)).toBeNull();
    }
  });
});
