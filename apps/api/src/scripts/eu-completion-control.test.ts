import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { CompletionApprovalError } from "@/api/handlers/case-law/ingestion/eu-completion-store";

import {
  parseEuCompletionControlCommand,
  runEuCompletionControl,
} from "./eu-completion-control";

const approvalArgs = [
  "approve",
  "--source",
  "019f6fd4-83c0-7000-8000-000000000001",
  "--parser-version",
  "2",
  "--receipt",
  "fixture-receipt",
  "--evidence",
  "fixture://supervised",
  "--supervised-by",
  "fixture-supervisor",
  "--supervised-at",
  "2026-10-02T00:00:00.000Z",
  "--who",
  "fixture-operator",
  "--when",
  "2026-10-02T00:01:00.000Z",
];
const unavailableApproval = async () => {
  throw new TypeError("Fixture must not approve");
};

describe("explicit EU completion operator commands", () => {
  test("help opens no database", async () => {
    let opened = 0;
    let help = "";
    const code = await runEuCompletionControl({
      args: ["--help"],
      createStore: async () => {
        opened++;
        return {
          setControl: async () => {},
          approveSupervisedDryRun: unavailableApproval,
        };
      },
      writeHelp: (text) => {
        help = text;
      },
    });
    expect(code).toBe(0);
    expect(opened).toBe(0);
    expect(help).toContain("--receipt");
    expect(help).toContain("--reviewed");
  });
  test("invalid approval counts fail before any owner connection is opened", async () => {
    let opened = 0;
    const messages: string[] = [];
    const createStore = async () => {
      opened++;
      return {
        setControl: async () => {},
        approveSupervisedDryRun: unavailableApproval,
      };
    };
    const write = (record: unknown) => {
      if (
        typeof record === "object" &&
        record !== null &&
        "message" in record &&
        typeof record.message === "string"
      ) {
        messages.push(record.message);
      }
    };
    for (const counts of [
      ["0", "0", "0"],
      ["2", "1", "0"],
      ["1000001", "1000001", "0"],
    ]) {
      const [reviewed, accepted, requiresReview] = counts;
      if (
        reviewed === undefined ||
        accepted === undefined ||
        requiresReview === undefined
      ) {
        throw new TypeError("Invalid fixture partition");
      }
      const code = await runEuCompletionControl({
        args: [
          ...approvalArgs,
          "--reviewed",
          reviewed,
          "--accepted",
          accepted,
          "--requires-review",
          requiresReview,
        ],
        createStore,
        write,
      });
      expect(code).toBe(1);
    }
    expect(opened).toBe(0);
    expect(messages.at(0)).toBe(
      "Reviewed counts must be a nonempty complete partition",
    );
  });
  test("operator approval rejection is reported without a false success", async () => {
    const records: unknown[] = [];
    const code = await runEuCompletionControl({
      args: [
        ...approvalArgs,
        "--reviewed",
        "1",
        "--accepted",
        "1",
        "--requires-review",
        "0",
      ],
      createStore: async () => ({
        setControl: async () => {},
        approveSupervisedDryRun: async () =>
          Result.err(
            new CompletionApprovalError({
              code: "not-found",
              message: "The supervised receipt does not exist",
            }),
          ),
      }),
      write: (record) => {
        records.push(record);
      },
    });
    expect(code).toBe(1);
    expect(records).toEqual([
      {
        event: "case_law.eu_completion.control_failed",
        code: "not-found",
        message: "The supervised receipt does not exist",
      },
    ]);
  });
  test("one attributed control command performs only its requested durable write", async () => {
    const changed: unknown[] = [];
    const code = await runEuCompletionControl({
      args: [
        "global",
        "--state",
        "off",
        "--who",
        "fixture-operator",
        "--when",
        "2026-10-02T00:01:00.000Z",
      ],
      createStore: async () => ({
        setControl: async (change) => {
          changed.push(change);
        },
        approveSupervisedDryRun: unavailableApproval,
      }),
      write: () => {},
    });
    expect(code).toBe(0);
    expect(changed).toEqual([
      {
        sourceId: null,
        state: "off",
        changedBy: "fixture-operator",
        changedAt: new Date("2026-10-02T00:01:00.000Z"),
      },
    ]);
  });
  test("approval command requires explicit evidence, supervision and a complete review partition", () => {
    const command = parseEuCompletionControlCommand([
      ...approvalArgs,
      "--reviewed",
      "2",
      "--accepted",
      "1",
      "--requires-review",
      "1",
    ]);
    expect(command.command).toBe("approve");
    expect(() =>
      parseEuCompletionControlCommand([
        "global",
        "--state",
        "on",
        "--who",
        "fixture",
        "--when",
        "9999-01-01T00:00:00.000Z",
      ]),
    ).toThrow(v.ValiError);
    expect(() =>
      parseEuCompletionControlCommand(["global", "--state", "on"]),
    ).toThrow(v.ValiError);
    expect(() =>
      parseEuCompletionControlCommand([
        ...approvalArgs,
        "--reviewed",
        "2",
        "--accepted",
        "1",
        "--requires-review",
        "1",
        "--state",
        "on",
      ]),
    ).toThrow(v.ValiError);
  });
});
