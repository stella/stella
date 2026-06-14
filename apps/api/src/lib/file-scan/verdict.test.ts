import { describe, expect, test } from "bun:test";

import type { ScanFinding } from "@/api/lib/file-scan/types";
import { aggregateVerdict } from "@/api/lib/file-scan/verdict";

const finding = (severity: ScanFinding["severity"]): ScanFinding => ({
  rule: `rule-${severity}`,
  severity,
  message: `${severity} finding`,
});

describe("aggregateVerdict (the chokepoint every file-scan gate depends on)", () => {
  test("no findings is a pass", () => {
    expect(aggregateVerdict([])).toBe("pass");
  });

  test("FAIL-CLOSED: a single 'reject' dominates any number of lesser findings", () => {
    expect(
      aggregateVerdict([finding("pass"), finding("warn"), finding("reject")]),
    ).toBe("reject");
    // order must not matter — reject still wins when it appears first
    expect(
      aggregateVerdict([finding("reject"), finding("warn"), finding("pass")]),
    ).toBe("reject");
  });

  test("warn dominates pass but never masks a reject", () => {
    expect(aggregateVerdict([finding("pass"), finding("warn")])).toBe("warn");
    expect(aggregateVerdict([finding("pass"), finding("pass")])).toBe("pass");
  });

  test("INVARIANT: result is the max-severity finding; adding findings never lowers it", () => {
    const rank = { pass: 0, warn: 1, reject: 2 } as const;
    const severities: ScanFinding["severity"][] = ["pass", "warn", "reject"];
    // every non-empty combination of up to 3 findings
    for (const a of severities) {
      for (const b of severities) {
        for (const c of severities) {
          const set = [finding(a), finding(b), finding(c)];
          let expected: ScanFinding["severity"] = "pass";
          for (const item of set) {
            if (rank[item.severity] > rank[expected]) {
              expected = item.severity;
            }
          }
          expect(aggregateVerdict(set)).toBe(expected);
          // monotonicity: appending another reject can only raise/keep
          expect(rank[aggregateVerdict([...set, finding("reject")])]).toBe(
            rank.reject,
          );
        }
      }
    }
  });
});
