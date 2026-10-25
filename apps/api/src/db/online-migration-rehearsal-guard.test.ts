import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { OnlineRepair } from "./online-migration-connection";
import {
  assertOnlineRepairRehearsalCoverage,
  parseOnlineRepairRehearsalArguments,
  parseOnlineRepairRehearsalReport,
} from "./online-migration-rehearsal-guard";
import type { OnlineRepairRehearsalRecord } from "./online-migration-rehearsal-guard";

const repair = (name: string) =>
  ({
    name,
    readCompletion: async () => ({ type: "complete" }) as const,
    repair: async () => ({ type: "complete" }) as const,
  }) satisfies OnlineRepair;

const checked = (name: string) =>
  ({ type: "checked", name, completion: "complete" }) as const;
const attempted = (name: string) => ({ type: "attempted", name }) as const;
const repairs = [repair("historical"), repair("current")];

const assertCoverage = (records: readonly OnlineRepairRehearsalRecord[]) =>
  assertOnlineRepairRehearsalCoverage({ records, repairs });

describe("online repair rehearsal coverage", () => {
  test("censuses completed historical repairs without pretending they ran", () => {
    assertCoverage([checked("historical"), checked("current")]);
    expect(() => assertCoverage([checked("historical")])).toThrow("current");
    expect(() => assertCoverage([])).toThrow("registered repairs");
  });

  test("every noncomplete check requires its actual ordered attempt", () => {
    for (const completion of ["pending", "incomplete"] as const) {
      const required = {
        type: "checked",
        name: "current",
        completion,
      } as const;
      assertCoverage([checked("historical"), required, attempted("current")]);
      expect(() => assertCoverage([checked("historical"), required])).toThrow(
        "missing attempt",
      );
      expect(() =>
        assertCoverage([required, checked("historical"), attempted("current")]),
      ).toThrow("missing attempt");
    }
  });

  test("resumed passes preserve a complete census and require each repeated pending attempt", () => {
    const pending = {
      type: "checked",
      name: "current",
      completion: "pending",
    } as const;
    assertCoverage([
      checked("historical"),
      pending,
      attempted("current"),
      checked("historical"),
      pending,
      attempted("current"),
      checked("historical"),
      checked("current"),
    ]);
    expect(() =>
      assertCoverage([
        checked("historical"),
        pending,
        attempted("current"),
        pending,
      ]),
    ).toThrow("missing attempt");
  });

  test("rejects orphan, duplicate, unknown and mismatched attempts", () => {
    expect(() => assertCoverage([attempted("current")])).toThrow(
      "unexpected attempt",
    );
    expect(() =>
      assertCoverage([
        checked("historical"),
        { type: "checked", name: "current", completion: "incomplete" },
        attempted("current"),
        attempted("current"),
      ]),
    ).toThrow("unexpected attempt");
    expect(() => assertCoverage([checked("unknown")])).toThrow(
      "unknown repair",
    );
    expect(() =>
      assertCoverage([
        { type: "checked", name: "current", completion: "pending" },
        attempted("historical"),
      ]),
    ).toThrow("missing attempt");
    expect(() =>
      assertOnlineRepairRehearsalCoverage({
        records: [checked("historical")],
        repairs: [repair("historical"), repair("historical")],
      }),
    ).toThrow("duplicate names");
  });

  test("requires the census and attempts for every generated upgrade state", () => {
    assertProperty(
      "requires the census and attempts for every generated upgrade state",
      fc.property(
        fc.array(fc.constantFrom("complete", "pending", "incomplete"), {
          minLength: 1,
          maxLength: 20,
        }),
        (completions) => {
          const registry = completions.map((_, index) => repair(String(index)));
          const records: OnlineRepairRehearsalRecord[] = [];
          for (const [index, completion] of completions.entries()) {
            const name = String(index);
            records.push({ type: "checked", name, completion });
            if (completion !== "complete") {
              records.push(attempted(name));
            }
          }
          assertOnlineRepairRehearsalCoverage({ repairs: registry, records });
          for (const [index, record] of records.entries()) {
            const missing = records.filter((_, offset) => offset !== index);
            expect(
              () =>
                assertOnlineRepairRehearsalCoverage({
                  repairs: registry,
                  records: missing,
                }),
              `missing ${record.type} ${record.name}`,
            ).toThrow(
              /Online repair rehearsal (?:is missing attempt|has an unexpected attempt|did not check registered repairs)/u,
            );
          }
        },
      ),
    );
  });
});

describe("online repair rehearsal report boundary", () => {
  test("roundtrips strict observations and rejects truncated or malformed records", () => {
    const records = [
      checked("historical"),
      { type: "checked", name: "current", completion: "pending" } as const,
      attempted("current"),
    ];
    const source = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    expect(parseOnlineRepairRehearsalReport(source)).toEqual(records);
    for (const [invalid, message] of [
      ["", "empty or truncated"],
      [source.slice(0, -1), "empty or truncated"],
      ["\n", "JSON Parse error"],
      ["{}\n", "Invalid type"],
      [
        '{"type":"checked","name":"x","completion":"unknown"}\n',
        "Invalid type",
      ],
      [
        '{"type":"checked","name":"x","completion":"complete","extra":true}\n',
        "Invalid key",
      ],
      ['{"type":"attempted","name":""}\n', "Invalid length"],
      ['{"type":"other","name":"x"}\n', "Invalid type"],
      [`${source}\n`, "JSON Parse error"],
    ] as const) {
      expect(() => parseOnlineRepairRehearsalReport(invalid)).toThrow(message);
    }
  });

  test("validates the optional report argument before opening a database", () => {
    expect(parseOnlineRepairRehearsalArguments([])).toBeNull();
    expect(
      parseOnlineRepairRehearsalArguments([
        "--rehearsal-online-repair-report",
        "/tmp/report.jsonl",
      ]),
    ).toBe("/tmp/report.jsonl");
    for (const args of [
      ["unknown"],
      ["--rehearsal-online-repair-report"],
      ["--rehearsal-online-repair-report", ""],
      ["--rehearsal-online-repair-report", "   "],
      ["--rehearsal-online-repair-report", "--other"],
      ["--rehearsal-online-repair-report", "a\0b"],
      ["--rehearsal-online-repair-report", "one", "two"],
    ]) {
      expect(() => parseOnlineRepairRehearsalArguments(args)).toThrow("Usage:");
    }
  });
});
