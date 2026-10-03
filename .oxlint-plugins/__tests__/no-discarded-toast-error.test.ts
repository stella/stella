import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);
const imports =
  'import { notifyUserError as notify } from "@/lib/errors/user-toast"; import { userErrorFromThrown as safe } from "@/lib/errors/user-safe"; import { userErrorMessage } from "@/lib/errors/messages";';
const lint = async (source: string) =>
  await lintSingleRule("no-discarded-toast-error", source);

describe("original error toast identity", () => {
  test("rejects missing errors in rejection and mutation callbacks", async () => {
    expect(
      await lint(
        [
          imports,
          'promise.catch(() => notify(undefined, "Failed"));',
          'const options = { onError: () => notify(undefined, "Failed") };',
          'try { run(); } catch (error) { notify(undefined, "Failed"); }',
          'promise.catch((error) => notify(void 0, "Failed"));',
        ].join("\n"),
      ),
    ).toEqual([2, 3, 4, 5]);
  });
  test("rejects error flattening before notification", async () => {
    expect(
      await lint(
        [
          imports,
          'notify(safe(error, "Failed"), "Failed");',
          'notify(userErrorMessage(error), "Failed");',
        ].join("\n"),
      ),
    ).toEqual([2, 3]);
  });
  test("allows synthetic failures and preserves original errors", async () => {
    expect(
      await lint(
        [
          imports,
          'notify(undefined, "Missing selection");',
          'promise.catch((error) => notify(error, "Failed"));',
          'const options = { onError: (error) => notify(error, "Failed") };',
          'try { run(); } catch (error) { notify(error, "Failed"); }',
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});
