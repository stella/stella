import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  readSuccessfulResponseConformanceBatch,
  writeResponseConformanceExecutionReport,
} from "./response-conformance-execution-report";

test("runtime report keeps successful batch provenance and counts each observation kind separately", () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "conformance-report-test-"),
  );
  try {
    const observations = [
      { kind: "http", identity: "GET /values/:id" },
      { kind: "http", identity: "GET /values/:id" },
      { kind: "handler-context", identity: "(direct handler)" },
      { kind: "mcp", identity: "list_matters" },
    ];
    writeFileSync(
      path.join(directory, "journal.json"),
      JSON.stringify({ version: 1, observations }),
    );
    const batch = readSuccessfulResponseConformanceBatch(directory, {
      label: "logic batch 1",
      testFiles: ["src/fixture.test.ts"],
    });
    const outputPath = path.join(directory, "report.json");
    expect(
      writeResponseConformanceExecutionReport({
        outputPath,
        successfulBatches: [batch],
        plannedBatches: 2,
        complete: false,
      }),
    ).toEqual({ httpRouteTemplates: 1, directHandlerContexts: 1, mcpTools: 1 });
    expect(JSON.parse(readFileSync(outputPath, "utf-8"))).toMatchObject({
      measure: "runtime-execution",
      complete: false,
      plannedBatches: 2,
      successfulBatches: 1,
      batches: [
        {
          label: "logic batch 1",
          testFiles: ["src/fixture.test.ts"],
          observations,
        },
      ],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing or malformed child journal cannot become execution evidence", () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "conformance-report-test-"),
  );
  try {
    const provenance = {
      label: "logic batch 1",
      testFiles: ["src/fixture.test.ts"],
    };
    expect(() =>
      readSuccessfulResponseConformanceBatch(directory, provenance),
    ).toThrow("did not emit");
    writeFileSync(
      path.join(directory, "journal.json"),
      JSON.stringify({
        version: 1,
        observations: [
          { kind: "http", identity: "GET /values/:id", payload: "unexpected" },
        ],
      }),
    );
    expect(() =>
      readSuccessfulResponseConformanceBatch(directory, provenance),
    ).toThrow("Invalid key");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
