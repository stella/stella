import { describe, expect, test } from "bun:test";

import {
  exceptionMismatches,
  exceptionsIn,
  NO_NATIVE_UI_EXCEPTIONS_PATH,
  readCommittedNoNativeUiExceptions,
  readNoNativeUiExceptions,
  UI_DRIFT_WRITE,
} from "../../scripts/ui-drift-ledgers.ts";

// Every directive that silences a `no-native-ui/*` rule in a surface that
// renders through @stll/ui is an exception to the design system. The ledger
// lists each one with its reason, so adding one, moving one or rewording its
// reason is a reviewed change to a file the design-system owners hold.
const HOW_TO_UPDATE =
  `Each exception to no-native-ui is listed in ${NO_NATIVE_UI_EXCEPTIONS_PATH} ` +
  "with its file, rule and the reason after `--`. If the change is deliberate " +
  `(the component cannot host this markup, and the reason says why), run ` +
  `\`${UI_DRIFT_WRITE}\` and commit the ledger with it; otherwise render the ` +
  "@stll/ui component and drop the directive.";

describe("no-native-ui exceptions ledger", () => {
  test("matches every no-native-ui directive in the consumer surfaces", () => {
    const errors = exceptionMismatches(
      readCommittedNoNativeUiExceptions(),
      readNoNativeUiExceptions(),
    );
    expect(errors, `${errors.join("\n")}\n\n${HOW_TO_UPDATE}`).toEqual([]);
  });
});

describe("exceptionsIn", () => {
  test("reads line, JSX and combined directives in both spellings", () => {
    const source = [
      "// oxlint-disable-next-line no-native-ui/no-native-button -- a row that hosts an input",
      "{/* oxlint-disable-next-line no-native-ui/no-native-table -- a source table */}",
      "// oxlint-disable-next-line react/no-array-index-key, no-native-ui/no-native-table -- fixed rows",
      "/* eslint-disable no-native-ui/no-native-dialog */",
      "// oxlint-disable-next-line no-console -- not a design-system rule",
      'const text = "no-native-ui/no-native-button";',
    ].join("\n");
    expect(exceptionsIn("a.tsx", source)).toEqual([
      {
        file: "a.tsx",
        rule: "no-native-ui/no-native-button",
        reason: "a row that hosts an input",
      },
      {
        file: "a.tsx",
        rule: "no-native-ui/no-native-table",
        reason: "a source table",
      },
      {
        file: "a.tsx",
        rule: "no-native-ui/no-native-table",
        reason: "fixed rows",
      },
      { file: "a.tsx", rule: "no-native-ui/no-native-dialog", reason: "" },
    ]);
  });
});

describe("exceptionMismatches", () => {
  const entry = {
    file: "a.tsx",
    rule: "no-native-ui/no-native-button",
    reason: "a row that hosts an input",
  };

  test("an unlisted directive fails and prints its entry", () => {
    expect(exceptionMismatches([], [entry])).toEqual([
      `a.tsx: new no-native-ui/no-native-button exception, not in the ledger: ${JSON.stringify(entry)}`,
    ]);
  });

  test("a listed exception the file dropped fails", () => {
    expect(exceptionMismatches([entry], [])).toEqual([
      `a.tsx: the ledger lists a no-native-ui/no-native-button exception the file no longer has: ${JSON.stringify(entry)}`,
    ]);
  });

  test("a reworded reason fails", () => {
    expect(
      exceptionMismatches([entry], [{ ...entry, reason: "something else" }]),
    ).toEqual([
      'a.tsx: the no-native-ui/no-native-button reason changed from "a row that hosts an input" to "something else"',
    ]);
  });

  test("a second identical directive needs a second entry", () => {
    expect(exceptionMismatches([entry], [entry, entry])).toHaveLength(1);
    expect(exceptionMismatches([entry, entry], [entry, entry])).toEqual([]);
  });

  test("a directive without a reason fails even when listed", () => {
    const bare = { ...entry, reason: "" };
    expect(exceptionMismatches([bare], [bare])).toEqual([
      "a.tsx: the no-native-ui/no-native-button directive gives no reason; write it after ` -- `",
    ]);
  });
});
