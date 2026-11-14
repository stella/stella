import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { parseEmptiedDocumentRepairArguments } from "@/api/lib/legal-search/sk-emptied-document-repair-command";

const SINCE = "2026-01-01T00:00:00Z";
const ID = "019dd417-c605-7000-ac71-ae02372705d3";

const parsed = (...argv: readonly string[]) => {
  const result = parseEmptiedDocumentRepairArguments(argv);
  if (Result.isError(result)) {
    throw new TypeError(`Expected valid arguments: ${result.error.message}`);
  }
  return result.value;
};

const refusal = (...argv: readonly string[]): string => {
  const result = parseEmptiedDocumentRepairArguments(argv);
  if (!Result.isError(result)) {
    throw new TypeError("Expected the arguments to be refused");
  }
  return result.error.message.split("\n").at(0) ?? "";
};

describe("requeue-sk-emptied-documents arguments", () => {
  test("a run without --apply is a dry run over one default window", () => {
    expect(parsed("--since", SINCE)).toEqual({
      since: new Date(SINCE),
      after: null,
      scan: 10_000,
      resultsOut: null,
      write: { type: "dry-run" },
    });
  });

  test("an applying run carries its reason, actor and results file", () => {
    expect(
      parsed(
        "--since",
        SINCE,
        "--after",
        ID,
        "--scan",
        "500",
        "--apply",
        "--reason",
        "  documents settled empty by the strict guard  ",
        "--actor",
        "operator",
        "--results-out",
        "/private/requeue.jsonl",
      ),
    ).toMatchObject({
      after: ID,
      scan: 500,
      resultsOut: "/private/requeue.jsonl",
      write: {
        type: "apply",
        reason: "documents settled empty by the strict guard",
        actor: "operator",
      },
    });
  });

  test("an applying run needs its record and attribution", () => {
    const base = ["--since", SINCE, "--apply"] as const;
    expect(refusal(...base, "--reason", "long enough", "--actor", "op")).toBe(
      "--apply requires --results-out",
    );
    expect(
      refusal(...base, "--reason", "long enough", "--results-out", "/p.jsonl"),
    ).toBe("--apply requires --actor");
    expect(
      refusal(
        ...base,
        "--reason",
        "short",
        "--actor",
        "op",
        "--results-out",
        "/p",
      ),
    ).toBe("--apply requires a --reason of at least eight characters");
  });

  test("a dry run takes no attribution", () => {
    expect(refusal("--since", SINCE, "--actor", "op")).toBe(
      "--reason and --actor are taken only with --apply",
    );
  });

  test("the window bound and the cursor are validated", () => {
    expect(refusal()).toBe("--since is required");
    expect(refusal("--since", "yesterday")).toBe(
      "--since must be an ISO instant, got: yesterday",
    );
    expect(refusal("--since", "2999-01-01T00:00:00Z")).toBe(
      "--since must not be in the future",
    );
    expect(refusal("--since", SINCE, "--after", "42")).toBe(
      "--after must be a decision id, got: 42",
    );
    for (const scan of ["0", "1.5", "50001", "10k"]) {
      expect(refusal("--since", SINCE, "--scan", scan)).toBe(
        `--scan must be an integer from 1 to 50000, got: ${scan}`,
      );
    }
    expect(refusal("--since", SINCE, "--since", SINCE)).toBe(
      "--since was given more than once",
    );
    expect(refusal("--since", SINCE, "--force")).toBe(
      'Unknown argument "--force"',
    );
  });
});
