import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_LEASE_WAIT_MINUTES,
  DEFAULT_LIMIT,
  parseReplayArguments,
  REPLAY_USAGE,
} from "@/api/handlers/case-law/ingestion/replay-arguments";

const parse = (...argv: readonly string[]) => parseReplayArguments(argv);

const parsed = (...argv: readonly string[]) => {
  const result = parse(...argv);
  if (Result.isError(result)) {
    throw new TypeError(`Expected valid arguments: ${result.error.message}`);
  }
  return result.value;
};

const rejection = (...argv: readonly string[]): string => {
  const result = parse(...argv);
  if (!Result.isError(result)) {
    throw new TypeError("Expected the arguments to be refused");
  }
  return result.error.message;
};

describe("how many decisions a replay run may visit", () => {
  test("caps the run by default, so an unflagged run cannot run away", () => {
    expect(parsed("--adapter", "eu-ecj").bound).toEqual({
      type: "at-most",
      limit: DEFAULT_LIMIT,
    });
  });

  test("--limit sets the cap", () => {
    expect(parsed("--adapter", "eu-ecj", "--limit", "20").bound).toEqual({
      type: "at-most",
      limit: 20,
    });
  });

  test("--all lifts the cap", () => {
    expect(parsed("--adapter", "eu-ecj", "--all").bound).toEqual({
      type: "all",
    });
  });

  test("--all with --limit is refused rather than resolved", () => {
    expect(rejection("--adapter", "eu-ecj", "--all", "--limit", "20")).toBe(
      "--all and --limit are mutually exclusive visit bounds",
    );
  });

  test.each([["0"], ["-5"], ["many"], ["0.5"], ["1e3"], ["20rows"]])(
    "--limit %p is not a count of decisions",
    (limit) => {
      expect(rejection("--adapter", "eu-ecj", "--limit", limit)).toBe(
        `--limit must be a positive integer, got: ${limit}`,
      );
    },
  );
});

describe("how long a writing run waits for the source's lease", () => {
  test("waits by default, so an unattended run does not lose to an ingestion", () => {
    expect(parsed("--adapter", "eu-ecj").leaseWaitMinutes).toBe(
      DEFAULT_LEASE_WAIT_MINUTES,
    );
  });

  test("zero is a bound, not a missing value: one attempt and no wait", () => {
    expect(
      parsed("--adapter", "eu-ecj", "--lease-wait", "0").leaseWaitMinutes,
    ).toBe(0);
  });

  test.each([["-1"], ["soon"], ["0.5"], ["30minutes"]])(
    "--lease-wait %p is not a wait",
    (minutes) => {
      expect(rejection("--adapter", "eu-ecj", "--lease-wait", minutes)).toBe(
        `--lease-wait must be a non-negative integer, got: ${minutes}`,
      );
    },
  );
});

describe("the rest of a replay's command line", () => {
  test("a run writes nothing and replays the whole source unless told otherwise", () => {
    expect(parsed("--adapter", "eu-ecj")).toMatchObject({
      adapterKey: "eu-ecj",
      after: null,
      apply: false,
      rejectionPolicy: "report",
      scope: { type: "source" },
    });
  });

  test("the writing flags are read as given", () => {
    expect(
      parsed("--adapter", "eu-ecj", "--apply", "--withdraw-rejected"),
    ).toMatchObject({ apply: true, rejectionPolicy: "withdraw-no-document" });
  });

  test("a court or a celex narrows the scope", () => {
    expect(
      parsed("--adapter", "cz-nss", "--court", "Nejvyšší soud").scope,
    ).toEqual({ type: "court", court: "Nejvyšší soud" });
    expect(
      parsed("--adapter", "eu-ecj", "--celex", "62022CJ0123").scope,
    ).toEqual({ type: "celex", celex: "62022CJ0123" });
  });

  test("two scopes at once are refused rather than ranked", () => {
    expect(
      rejection(
        "--adapter",
        "eu-ecj",
        "--celex",
        "62022CJ0123",
        "--court",
        "X",
      ),
    ).toBe("--celex and --court are mutually exclusive replay scopes");
  });

  test("a flag whose value is the next flag has no value", () => {
    expect(rejection("--adapter", "eu-ecj", "--court", "--apply")).toBe(
      "--court requires a value",
    );
  });

  test("no adapter is a usage error", () => {
    expect(rejection("--limit", "20")).toBe(REPLAY_USAGE);
  });

  // Reading the first occurrence and stopping would let the second one
  // through unread: the run would use a bound the operator did not write,
  // and an invalid repeat would never be reported at all.
  test.each([
    [["--adapter", "eu-ecj", "--limit", "20", "--limit", "20rows"], "--limit"],
    [["--adapter", "eu-ecj", "--adapter", "cz-nss"], "--adapter"],
    [["--adapter", "eu-ecj", "--court", "A", "--court", "B"], "--court"],
  ])("a value flag given twice is refused (%p)", (argv, flag) => {
    expect(rejection(...argv)).toBe(`${flag} was given more than once`);
  });
});
