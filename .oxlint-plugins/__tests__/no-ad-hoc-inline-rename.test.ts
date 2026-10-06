import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(30_000);

const lint = async (
  source: string,
  sourcePath = "apps/web/src/components/example.tsx",
) => await lintSingleRule("no-ad-hoc-inline-rename", source, { sourcePath });

const nativeRename = `const Title = ({ editing, rename }) => editing && <input onBlur={rename.commit} onKeyDown={rename.onKeyDown} value={rename.draft} />;`;

describe("shared inline rename ownership", () => {
  test("rejects native inputs, imported aliases and autofocus editors in view/edit owners", async () => {
    expect(
      await lint(
        [
          'import { Input as TextInput } from "@stll/ui/input";',
          nativeRename,
          "function Name({ isRenaming, rename }) { return isRenaming ? <TextInput onBlur={rename.commit} onKeyDown={rename.onKeyDown} value={rename.draft} /> : <span />; }",
          "const Anonymous = ({ editMode, commit, handleKeyDown }) => editMode && <input autoFocus onBlur={commit} onKeyDown={handleKeyDown} />;",
          "const Discriminated = ({ state, rename }) => state.status === 'editing' && <input onBlur={rename.commit} onKeyDown={rename.onKeyDown} />;",
        ].join("\n"),
      ),
    ).toEqual([2, 3, 4, 5]);
  });

  test("enforces the same ownership for desktop inputs", async () => {
    expect(
      await lint(nativeRename, "apps/desktop/src/clipboard/ClipboardApp.tsx"),
    ).toEqual([1]);
  });

  test("exempts only the canonical owner for the same offending input", async () => {
    expect(await lint(nativeRename)).toEqual([1]);
    expect(
      await lint(nativeRename, "packages/ui/src/components/inline-rename.tsx"),
    ).toEqual([]);
    expect(
      await lint(
        nativeRename,
        "packages/other/src/components/inline-rename.tsx",
      ),
    ).toEqual([1]);
  });

  test("permits the shared input, permanent fields and creation forms", async () => {
    expect(
      await lint(
        [
          'import { InlineRenameInput } from "@stll/ui/inline-rename";',
          'import { Input as TextInput } from "@stll/ui/input";',
          "const Shared = ({ editing, rename }) => editing && <InlineRenameInput value={rename.draft} onCommit={rename.commit} onCancel={rename.cancel} />;",
          "const Permanent = ({ rename }) => <TextInput onBlur={rename.commit} onKeyDown={rename.onKeyDown} value={rename.draft} />;",
          "const Create = ({ creating, create }) => creating && <input autoFocus onBlur={create.commit} onKeyDown={create.onKeyDown} />;",
          "const Ordinary = ({ validate, handleKeyDown }) => <input onBlur={validate} onKeyDown={handleKeyDown} />;",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("requires both blur and keyboard commit handlers plus a rename binding or autofocus", async () => {
    expect(
      await lint(
        [
          "const BlurOnly = ({ editing, rename }) => editing && <input autoFocus onBlur={rename.commit} />;",
          "const KeyOnly = ({ editing, rename }) => editing && <input autoFocus onKeyDown={rename.onKeyDown} />;",
          "const Confirmation = ({ rename }) => <input autoFocus onChange={rename.setConfirmation} />;",
          "const Generic = ({ editing, validate, handleKeyDown }) => editing && <input onBlur={validate} onKeyDown={handleKeyDown} />;",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("leaves numeric and multiline editing contracts outside inline renaming", async () => {
    expect(
      await lint(
        [
          "const Numeric = ({ editing, rename }) => editing && <input autoFocus inputMode='numeric' onBlur={rename.commit} onKeyDown={rename.onKeyDown} />;",
          "const Decimal = ({ editing, rename }) => editing && <input autoFocus inputMode='decimal' onBlur={rename.commit} onKeyDown={rename.onKeyDown} />;",
          "const Multiline = ({ editing, rename }) => editing && <textarea autoFocus onBlur={rename.commit} onKeyDown={rename.onKeyDown} />;",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});
