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
  test("follows extracted callbacks, aliases and lexical bindings", async () => {
    expect(
      await lint(
        [
          imports,
          'const onError = () => notify(undefined, "Failed"); mutate(value, { onError });',
          'const handler = () => notify(void 0, "Failed"); promise.catch(handler);',
          'function failed(error) { notify(undefined, "Failed"); } promise.catch(failed);',
          'const original = () => notify(undefined, "Failed"); const alias = original; promise.catch(alias);',
          'const typed = (() => notify(undefined, "Failed")) satisfies Handler; mutate(value, { onError: typed });',
          'const later = () => notify(undefined, "Failed"); promise.catch(later);',
          'const clean = (error) => notify(error, "Failed"); mutate(value, { onError: clean }); promise.catch(clean);',
          'const synthetic = () => notify(undefined, "Missing selection"); button.onClick = synthetic;',
          'const shadowed = () => notify(undefined, "Missing selection"); { const shadowed = (error) => notify(error, "Failed"); promise.catch(shadowed); }',
          'const fulfilled = () => notify(undefined, "Missing selection"); promise.then(fulfilled);',
          'const extraArgument = () => notify(undefined, "Missing selection"); promise.catch(clean, extraArgument);',
          'let replaced = () => notify(undefined, "Missing selection"); replaced = (error) => notify(error, "Failed"); promise.catch(replaced);',
          'const originalSynthetic = () => notify(undefined, "Missing selection"); let replacedAlias = originalSynthetic; replacedAlias = clean; promise.catch(replacedAlias);',
        ].join("\n"),
      ),
    ).toEqual([2, 3, 4, 5, 6, 7]);
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
