import { afterEach, describe, expect, test } from "bun:test";

import type { Block, DocumentAst } from "@stll/legal-ast/document-ast";

import {
  checkDecisionRetention,
  checkProjectedRetention,
  MAX_RETENTION_CHECKS_IN_FLIGHT,
  RETENTION_CHECK_BACKLOG,
  RETENTION_UNCHECKED,
  RETENTION_UNVERIFIABLE,
  RETENTION_UNVERIFIABLE_REASON,
  settleRetentionChecks,
  startDecisionRetentionCheck,
} from "@/api/handlers/case-law/ingestion/retention/retention-check";
import {
  RETENTION_PROJECTION_FAILURE,
  RETENTION_TEXT_ABSENCE,
  RETENTION_UNPARSED_REASON,
  type RetentionPolicy,
  type RetentionProjection,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import {
  AST_CONTENT_LOST,
  buildValidationHtml,
} from "@/api/lib/legal-search/parsers/validate-ast";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import {
  type LogRecord,
  resetLogSinkForTesting,
  setLogSinkForTesting,
} from "@/api/lib/observability/logger";

const TEXT =
  "Soud rozhodl o odvolání žalobce a rozsudek potvrdil v celém rozsahu.";
const LOST_PARAGRAPH =
  "Odůvodnění rozsudku obsahuje rozsáhlé úvahy o věci samé, o důkazech, o právním posouzení a o nákladech řízení před soudy obou stupňů.";

const paragraph = (text: string): Block => ({
  id: "p1",
  anchorId: "p1",
  type: "paragraph",
  plainText: text,
  inlines: [{ type: "text", text }],
});

const completionOf = async (promise: Promise<void>) =>
  await promise.then(
    () => "resolved",
    () => "rejected",
  );

const documentAst = (blocks: Block[]): DocumentAst => ({
  version: 1,
  source: { system: "test", documentId: "d1", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: "1 Co 1/2026",
    ecli: null,
    court: "Krajský soud",
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks,
});

const decision = (sourceRaw: string | undefined): IngestionResult =>
  plainTextIngestionResult({
    caseNumber: "1 Co 1/2026",
    court: "Krajský soud",
    country: "CZ",
    language: "cs",
    metadata: {},
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    rawHash: "0".repeat(64),
    documentAst: documentAst([paragraph(TEXT)]),
    sourceUrl: "https://example.invalid/1-co-1-2026",
    ...(sourceRaw === undefined ? {} : { sourceRaw }),
  });

const checked = (
  project: (sourceRaw: string) => Promise<RetentionProjection>,
): RetentionPolicy => ({ type: "checked", project });

/** Every record the logger emitted while `run` ran. */
const logged = async (run: () => Promise<void>): Promise<LogRecord[]> => {
  const records: LogRecord[] = [];
  setLogSinkForTesting((record) => {
    records.push(record);
  });
  await run();
  return records;
};

afterEach(() => {
  resetLogSinkForTesting();
});

describe("checkDecisionRetention", () => {
  test("a projection that keeps the decision's text logs no error", async () => {
    const records = await logged(async () =>
      checkDecisionRetention({
        adapterKey: "cz-regional",
        policy: checked(async () => ({
          type: "source",
          source: buildValidationHtml([TEXT]),
        })),
        result: decision("<p>stored</p>"),
      }),
    );
    // The one-paragraph fixture draws the oracle's structure warning; only
    // an error would say text was lost or left unmeasured.
    expect(
      records.filter(({ severityText }) => severityText === "ERROR"),
    ).toEqual([]);
  });

  test("text the parser lost is reported by the oracle", async () => {
    const records = await logged(async () =>
      checkDecisionRetention({
        adapterKey: "cz-regional",
        policy: checked(async () => ({
          type: "source",
          source: buildValidationHtml([TEXT, LOST_PARAGRAPH]),
        })),
        result: decision("<p>stored</p>"),
      }),
    );
    expect(records.map(({ message }) => message)).toContain(AST_CONTENT_LOST);
  });

  test("text kept in a separate document is logged once, at info", async () => {
    const records = await logged(async () =>
      checkDecisionRetention({
        adapterKey: "cz-uohs",
        policy: checked(async () => ({
          type: "no-text",
          reason: RETENTION_TEXT_ABSENCE.SEPARATE_DOCUMENT,
        })),
        result: decision("{}"),
      }),
    );
    expect(records).toEqual([
      {
        severityText: "INFO",
        message: RETENTION_UNCHECKED,
        attributes: expect.objectContaining({
          parser: "cz-uohs",
          caseNumber: "1 Co 1/2026",
          reason: RETENTION_TEXT_ABSENCE.SEPARATE_DOCUMENT,
        }),
      },
    ]);
  });

  test("a document built without publisher text stays an error", async () => {
    const records = await logged(async () =>
      checkDecisionRetention({
        adapterKey: "pl-sn",
        policy: checked(async () => ({
          type: "no-text",
          reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED,
        })),
        result: decision("{}"),
      }),
    );
    expect(records).toEqual([
      {
        severityText: "ERROR",
        message: RETENTION_UNVERIFIABLE,
        attributes: expect.objectContaining({
          reason: RETENTION_UNVERIFIABLE_REASON.DOCUMENT_WITHOUT_PUBLISHER_TEXT,
          absence: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED,
        }),
      },
    ]);
  });

  test("an unreadable raw is reported with the projection's reason", async () => {
    const records = await logged(async () =>
      checkDecisionRetention({
        adapterKey: "pl-sn",
        policy: checked(async () => ({
          type: "unreadable",
          reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_DOCUMENT,
        })),
        result: decision("{}"),
      }),
    );
    expect(records.map(({ attributes }) => attributes)).toEqual([
      expect.objectContaining({
        reason: RETENTION_UNVERIFIABLE_REASON.PROJECTION_FAILED,
        failure: RETENTION_PROJECTION_FAILURE.UNREADABLE_DOCUMENT,
      }),
    ]);
  });

  test("a projection that rejects or throws is reported, never raised", async () => {
    for (const project of [
      async () => {
        throw new TypeError("the reader broke");
      },
      async (): Promise<RetentionProjection> => {
        throw new RangeError("the reader broke before its promise");
      },
    ]) {
      const records = await logged(async () =>
        checkDecisionRetention({
          adapterKey: "pl-sn",
          policy: checked(project),
          result: decision("{}"),
        }),
      );
      expect(records).toEqual([
        {
          severityText: "ERROR",
          message: RETENTION_UNVERIFIABLE,
          attributes: expect.objectContaining({
            parser: "pl-sn",
            reason: RETENTION_UNVERIFIABLE_REASON.CHECK_FAILED,
            errorTag: expect.stringMatching(/Error$/u),
          }),
        },
      ]);
    }
  });

  test("a decision without a stored raw is reported", async () => {
    const records = await logged(async () =>
      checkDecisionRetention({
        adapterKey: "cz-regional",
        policy: checked(async () => ({ type: "source", source: TEXT })),
        result: decision(undefined),
      }),
    );
    expect(records.map(({ attributes }) => attributes?.["reason"])).toEqual([
      RETENTION_UNVERIFIABLE_REASON.NO_SOURCE_RAW,
    ]);
  });

  test("an unparsed source that built a document is reported", async () => {
    const records = await logged(async () =>
      checkDecisionRetention({
        adapterKey: "sk-courts",
        policy: {
          type: "unparsed",
          reason: RETENTION_UNPARSED_REASON.METADATA_ONLY,
        },
        result: decision("{}"),
      }),
    );
    expect(records.map(({ attributes }) => attributes?.["reason"])).toEqual([
      RETENTION_UNVERIFIABLE_REASON.UNPARSED_SOURCE_BUILT_DOCUMENT,
    ]);
  });
});

describe("checkProjectedRetention", () => {
  test("names the adapter as the parser in the oracle's signal", async () => {
    const records = await logged(async () =>
      checkProjectedRetention({
        adapterKey: "sk-courts",
        subject: { caseNumber: "1Co/1/2026", language: "sk" },
        project: async () => ({
          type: "source",
          source: {
            type: "paragraphs",
            paragraphs: [TEXT, LOST_PARAGRAPH],
          },
        }),
        blocks: [paragraph(TEXT)],
      }),
    );
    expect(
      records.find(({ message }) => message === AST_CONTENT_LOST)?.attributes,
    ).toMatchObject({ parser: "sk-courts", caseNumber: "1Co/1/2026" });
  });
});

describe("a log sink that throws", () => {
  const throwingSink = () => {
    setLogSinkForTesting(() => {
      throw new Error("the log sink is down");
    });
  };

  test("never rejects a decision check, on any branch", async () => {
    throwingSink();
    const notPublished = checked(async () => ({
      type: "no-text",
      reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED,
    }));
    const policies: RetentionPolicy[] = [
      { type: "unparsed", reason: RETENTION_UNPARSED_REASON.METADATA_ONLY },
      notPublished,
      checked(async () => {
        throw new TypeError("the reader broke");
      }),
      checked(async () => ({
        type: "source",
        source: buildValidationHtml([TEXT, LOST_PARAGRAPH]),
      })),
    ];
    for (const policy of policies) {
      expect(
        await completionOf(
          checkDecisionRetention({
            adapterKey: "cz-regional",
            policy,
            result: decision("{}"),
          }),
        ),
      ).toBe("resolved");
    }
    expect(
      await completionOf(
        checkDecisionRetention({
          adapterKey: "cz-regional",
          policy: notPublished,
          result: decision(undefined),
        }),
      ),
    ).toBe("resolved");
  });

  test("never rejects a projected check", async () => {
    throwingSink();
    expect(
      await completionOf(
        checkProjectedRetention({
          adapterKey: "sk-courts",
          subject: { caseNumber: "1Co/1/2026" },
          project: async () => {
            throw new TypeError("the reader broke");
          },
          blocks: [paragraph(TEXT)],
        }),
      ),
    ).toBe("resolved");
  });
});

describe("startDecisionRetentionCheck", () => {
  test("returns before the projection runs, and settles after it", async () => {
    let projected = 0;
    const started = startDecisionRetentionCheck({
      adapterKey: "cz-regional",
      policy: checked(async () => {
        projected += 1;
        return {
          type: "source",
          source: buildValidationHtml([TEXT]),
        };
      }),
      result: decision("<p>stored</p>"),
    });
    expect(projected).toBe(0);
    await started;
    expect(projected).toBe(1);
  });

  test("past the in-flight bound, a decision is reported unchecked", async () => {
    const release = Promise.withResolvers<RetentionProjection>();
    const records = await logged(async () => {
      const blocked = Array.from(
        { length: MAX_RETENTION_CHECKS_IN_FLIGHT },
        async () =>
          startDecisionRetentionCheck({
            adapterKey: "pl-sn",
            policy: checked(async () => release.promise),
            result: decision("{}"),
          }),
      );
      await startDecisionRetentionCheck({
        adapterKey: "pl-sn",
        policy: checked(async () => release.promise),
        result: decision("{}"),
      });
      release.resolve({
        type: "no-text",
        reason: RETENTION_TEXT_ABSENCE.SEPARATE_DOCUMENT,
      });
      await Promise.all(blocked);
      await settleRetentionChecks();
    });
    expect(
      records.filter(
        ({ attributes }) => attributes?.["reason"] === RETENTION_CHECK_BACKLOG,
      ),
    ).toHaveLength(1);
    expect(
      records.filter(
        ({ attributes }) =>
          attributes?.["reason"] === RETENTION_TEXT_ABSENCE.SEPARATE_DOCUMENT,
      ),
    ).toHaveLength(MAX_RETENTION_CHECKS_IN_FLIGHT);
  });

  test("a document over the projection's budget is logged unchecked", async () => {
    const records = await logged(async () =>
      checkDecisionRetention({
        adapterKey: "pl-sn",
        policy: checked(async () => ({
          type: "no-text",
          reason: RETENTION_TEXT_ABSENCE.OVER_CHECK_BUDGET,
        })),
        result: decision("{}"),
      }),
    );
    expect(
      records.map(({ severityText, message }) => [severityText, message]),
    ).toEqual([["INFO", RETENTION_UNCHECKED]]);
  });
});
