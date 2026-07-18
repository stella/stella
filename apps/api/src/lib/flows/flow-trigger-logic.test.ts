import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  deriveFileExtension,
  fileUploadTriggerMatches,
  flowScheduleToSchedulerSchedule,
  isAutomatedRunCapReached,
  shouldRunScheduledFlowNow,
} from "@/api/lib/flows/flow-trigger-logic";
import { MAX_AUTOMATED_FLOW_RUNS_PER_DEFINITION_PER_DAY } from "@/api/lib/flows/flow-types";

const ws = (id: string) => toSafeId<"workspace">(id);

describe("deriveFileExtension", () => {
  test("lowercases the final extension", () => {
    expect(deriveFileExtension("Contract.PDF")).toBe("pdf");
    expect(deriveFileExtension("report.docx")).toBe("docx");
  });

  test("uses only the last segment of a multi-dot name", () => {
    expect(deriveFileExtension("archive.tar.gz")).toBe("gz");
  });

  test("returns null when there is no usable extension", () => {
    expect(deriveFileExtension("README")).toBeNull();
    expect(deriveFileExtension(".gitignore")).toBeNull();
    expect(deriveFileExtension("trailingdot.")).toBeNull();
  });
});

describe("fileUploadTriggerMatches", () => {
  test("null workspace filter matches every workspace", () => {
    expect(
      fileUploadTriggerMatches({
        trigger: {
          type: "file-upload",
          workspaceIds: null,
          fileExtensions: null,
        },
        workspaceId: ws("ws-1"),
        extension: "pdf",
      }),
    ).toBe(true);
  });

  test("workspace filter includes only listed workspaces", () => {
    const trigger = {
      type: "file-upload" as const,
      workspaceIds: ["ws-1", "ws-2"],
      fileExtensions: null,
    };
    expect(
      fileUploadTriggerMatches({
        trigger,
        workspaceId: ws("ws-2"),
        extension: null,
      }),
    ).toBe(true);
    expect(
      fileUploadTriggerMatches({
        trigger,
        workspaceId: ws("ws-9"),
        extension: null,
      }),
    ).toBe(false);
  });

  test("extension match is case-insensitive and dot-agnostic", () => {
    const trigger = {
      type: "file-upload" as const,
      workspaceIds: null,
      fileExtensions: [".PDF", "Docx"],
    };
    expect(
      fileUploadTriggerMatches({
        trigger,
        workspaceId: ws("ws-1"),
        extension: "pdf",
      }),
    ).toBe(true);
    expect(
      fileUploadTriggerMatches({
        trigger,
        workspaceId: ws("ws-1"),
        extension: "docx",
      }),
    ).toBe(true);
    expect(
      fileUploadTriggerMatches({
        trigger,
        workspaceId: ws("ws-1"),
        extension: "txt",
      }),
    ).toBe(false);
  });

  test("a file with no extension cannot match a non-null extension filter", () => {
    expect(
      fileUploadTriggerMatches({
        trigger: {
          type: "file-upload",
          workspaceIds: null,
          fileExtensions: ["pdf"],
        },
        workspaceId: ws("ws-1"),
        extension: null,
      }),
    ).toBe(false);
  });
});

describe("isAutomatedRunCapReached", () => {
  test("is false below the cap and true at or over it", () => {
    expect(isAutomatedRunCapReached(0)).toBe(false);
    expect(
      isAutomatedRunCapReached(
        MAX_AUTOMATED_FLOW_RUNS_PER_DEFINITION_PER_DAY - 1,
      ),
    ).toBe(false);
    expect(
      isAutomatedRunCapReached(MAX_AUTOMATED_FLOW_RUNS_PER_DEFINITION_PER_DAY),
    ).toBe(true);
    expect(
      isAutomatedRunCapReached(
        MAX_AUTOMATED_FLOW_RUNS_PER_DEFINITION_PER_DAY + 5,
      ),
    ).toBe(true);
  });
});

describe("flowScheduleToSchedulerSchedule", () => {
  test("maps every frequency to a daily UTC tick at hourUtc:00", () => {
    expect(
      flowScheduleToSchedulerSchedule({ frequency: "daily", hourUtc: 9 }),
    ).toEqual({ type: "daily", hour: 9, minute: 0, timeZone: "UTC" });
    expect(
      flowScheduleToSchedulerSchedule({
        frequency: "weekly",
        hourUtc: 6,
        dayOfWeek: 3,
      }),
    ).toEqual({ type: "daily", hour: 6, minute: 0, timeZone: "UTC" });
    expect(
      flowScheduleToSchedulerSchedule({
        frequency: "monthly",
        hourUtc: 0,
        dayOfMonth: 15,
      }),
    ).toEqual({ type: "daily", hour: 0, minute: 0, timeZone: "UTC" });
  });
});

describe("shouldRunScheduledFlowNow", () => {
  // 2026-07-01 is a Wednesday (UTC weekday 3).
  const wednesday = new Date("2026-07-01T09:00:00.000Z");

  test("daily always runs", () => {
    expect(
      shouldRunScheduledFlowNow({ frequency: "daily", hourUtc: 9 }, wednesday),
    ).toBe(true);
  });

  test("weekly runs only on the matching UTC weekday", () => {
    expect(
      shouldRunScheduledFlowNow(
        { frequency: "weekly", hourUtc: 9, dayOfWeek: 3 },
        wednesday,
      ),
    ).toBe(true);
    expect(
      shouldRunScheduledFlowNow(
        { frequency: "weekly", hourUtc: 9, dayOfWeek: 1 },
        wednesday,
      ),
    ).toBe(false);
  });

  test("weekly with no configured day fails closed (never runs)", () => {
    expect(
      shouldRunScheduledFlowNow({ frequency: "weekly", hourUtc: 9 }, wednesday),
    ).toBe(false);
  });

  test("monthly runs only on the matching UTC day of month", () => {
    expect(
      shouldRunScheduledFlowNow(
        { frequency: "monthly", hourUtc: 9, dayOfMonth: 1 },
        wednesday,
      ),
    ).toBe(true);
    expect(
      shouldRunScheduledFlowNow(
        { frequency: "monthly", hourUtc: 9, dayOfMonth: 15 },
        wednesday,
      ),
    ).toBe(false);
  });

  test("monthly with no configured day fails closed (never runs)", () => {
    expect(
      shouldRunScheduledFlowNow(
        { frequency: "monthly", hourUtc: 9 },
        wednesday,
      ),
    ).toBe(false);
  });
});
