import { describe, expect, test } from "bun:test";

import { checkPrBody, formatPrBodyCheck } from "./check-pr-body";
import markers from "./pr-body-log-markers.json" with { type: "json" };

const prefixes = ["", "  ", "- ", "* ", "+ ", "1. ", "`", "  - ``"];

describe("pull request body tool log guard", () => {
  for (const marker of markers) {
    for (const prefix of prefixes) {
      test(`refuses ${JSON.stringify(prefix + marker)}`, () => {
        expect(checkPrBody(`${prefix}${marker} detail`)).toEqual([
          { line: 1, marker },
        ]);
      });
    }

    test(`matches ${marker} case-insensitively`, () => {
      expect(checkPrBody(marker.toLowerCase())).toEqual([{ line: 1, marker }]);
    });
  }

  test("reports every offending line and the neutral failure message", () => {
    expect(formatPrBodyCheck("Summary\nproof: command\n- EXIT: 1")).toEqual({
      exitCode: 1,
      lines: [
        "line 2: PROOF:",
        "line 3: EXIT:",
        "PR body contains tool log lines; keep logs out of the description",
      ],
    });
  });

  test("only matches markers at line start, including inside fenced blocks", () => {
    expect(
      checkPrBody(
        "The proof: is described here.\n```text\nPROOF: quoted log\nA quoted EXIT: in prose\n```",
      ),
    ).toEqual([{ line: 3, marker: "PROOF:" }]);
  });

  test("accepts an ordinary description", () => {
    expect(
      formatPrBodyCheck(
        "## Summary\n\nThis improves pull request linting.\n\n## Testing\nAll checks pass.",
      ),
    ).toEqual({ exitCode: 0, lines: [] });
  });
});
