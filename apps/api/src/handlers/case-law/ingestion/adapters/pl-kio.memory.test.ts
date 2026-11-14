import { panic } from "better-result";
import { expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PL_KIO_HTML_BUDGET,
  PL_KIO_RESPONSE_BYTE_CAP,
} from "@/api/handlers/case-law/ingestion/adapters/pl-kio-response-budget";

const API_ROOT = path.resolve(import.meta.dir, "../../../../..");
const MEMORY_CHILD = fileURLToPath(
  new URL("__fixtures__/pl-kio-memory-child.ts", import.meta.url),
);
const MEMORY_BUDGET_BYTES = 1024 * 1024 * 1024;
const MEMORY_HEADROOM_BYTES = MEMORY_BUDGET_BYTES * 0.9;
const MEMORY_WORKLOAD_TIMEOUT_MS = 180_000;
const ATTRIBUTE_FLOOD_DEADLINE_MS = 10_000;
const TWELVE_MIB = 12 * 1024 * 1024;
const SIXTEEN_MIB = 16 * 1024 * 1024;
const RESPONSE_SIZES = [256 * 1024, 1024 * 1024, TWELVE_MIB, SIXTEEN_MIB];
const INGESTION_PATHS = ["fetch", "replay"] as const;

const runMemoryChild = async (
  targetBytes: number,
  workload = "accepted",
  ingestionPath: (typeof INGESTION_PATHS)[number] = "fetch",
) => {
  // The API runner shares a process across test files. Do not make a child
  // inherit live allocations from a large fixture exercised before this one.
  Bun.gc(true);
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      path.join(API_ROOT, "src/tests/setup-env.ts"),
      MEMORY_CHILD,
      String(targetBytes),
      workload,
      ingestionPath,
    ],
    {
      timeout:
        workload === "attributes"
          ? ATTRIBUTE_FLOOD_DEADLINE_MS
          : MEMORY_WORKLOAD_TIMEOUT_MS,
      killSignal: "SIGKILL",
      cwd: API_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    panic(`KIO memory child failed (${exitCode}): ${stderr}`);
  }
  const outputLine = stdout.trim().split("\n").at(-1);
  if (outputLine === undefined || outputLine === "") {
    panic(`KIO child emitted no memory receipt: ${stderr}`);
  }
  const receipt: unknown = JSON.parse(outputLine);
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    !("peakRssBytes" in receipt) ||
    typeof receipt.peakRssBytes !== "number" ||
    !(receipt.peakRssBytes > 0) ||
    !("targetBytes" in receipt) ||
    typeof receipt.targetBytes !== "number" ||
    !("documentBytes" in receipt) ||
    typeof receipt.documentBytes !== "number" ||
    !("fulltextChars" in receipt) ||
    typeof receipt.fulltextChars !== "number" ||
    !("astBlocks" in receipt) ||
    (typeof receipt.astBlocks !== "number" && receipt.astBlocks !== null) ||
    !("rawEnvelopeBytes" in receipt) ||
    typeof receipt.rawEnvelopeBytes !== "number" ||
    !("rawContainsDocument" in receipt) ||
    typeof receipt.rawContainsDocument !== "boolean" ||
    !("budgetType" in receipt) ||
    typeof receipt.budgetType !== "string" ||
    !("markupTokens" in receipt) ||
    typeof receipt.markupTokens !== "number" ||
    !("boundaryBudgetType" in receipt) ||
    typeof receipt.boundaryBudgetType !== "string" ||
    !("overflowBudgetType" in receipt) ||
    typeof receipt.overflowBudgetType !== "string" ||
    !("path" in receipt) ||
    typeof receipt.path !== "string"
  ) {
    panic(`KIO child emitted an invalid receipt: ${outputLine}`);
  }
  const memoryReceipt = {
    targetBytes: receipt.targetBytes,
    documentBytes: receipt.documentBytes,
    fulltextChars: receipt.fulltextChars,
    astBlocks: receipt.astBlocks,
    rawEnvelopeBytes: receipt.rawEnvelopeBytes,
    rawContainsDocument: receipt.rawContainsDocument,
    budgetType: receipt.budgetType,
    markupTokens: receipt.markupTokens,
    boundaryBudgetType: receipt.boundaryBudgetType,
    overflowBudgetType: receipt.overflowBudgetType,
    path: receipt.path,
  };
  // The child reports its own high-water RSS; see the memory child fixture.
  const peakBytes = receipt.peakRssBytes;
  return { receipt: memoryReceipt, peakBytes, exitCode, stderr };
};

test(
  "accepted KIO documents retain text, AST and raw within the worker memory headroom",
  async () => {
    for (const ingestionPath of INGESTION_PATHS) {
      for (const targetBytes of RESPONSE_SIZES) {
        const { receipt, peakBytes, exitCode, stderr } = await runMemoryChild(
          targetBytes,
          "accepted",
          ingestionPath,
        );
        expect(exitCode, stderr).toBe(0);
        expect(receipt.targetBytes).toBe(targetBytes);
        expect(receipt.documentBytes).toBe(targetBytes);
        expect(receipt.fulltextChars).toBeGreaterThan(targetBytes * 0.7);
        expect(receipt.astBlocks).toBeGreaterThan(0);
        expect(receipt.rawEnvelopeBytes).toBeGreaterThanOrEqual(targetBytes);
        expect(receipt.rawContainsDocument).toBe(true);
        expect(receipt.budgetType).toBe("accepted");
        expect(receipt.boundaryBudgetType).toBe("accepted");
        expect(receipt.overflowBudgetType).toBe("markup-budget-exceeded");
        expect(receipt.path).toBe(ingestionPath);
        if (targetBytes === PL_KIO_RESPONSE_BYTE_CAP.document) {
          expect(PL_KIO_HTML_BUDGET.maxDomAllocations).toBeLessThanOrEqual(
            10_000,
          );
          expect(receipt.markupTokens).toBeGreaterThanOrEqual(
            PL_KIO_HTML_BUDGET.maxDomAllocations * 0.9,
          );
        }
        expect(peakBytes).toBeGreaterThan(0);
        expect(peakBytes).toBeLessThan(MEMORY_HEADROOM_BYTES);
        console.log(
          JSON.stringify({
            benchmark: "pl-kio-document-assembly",
            targetBytes,
            peakBytes,
            memoryBudgetBytes: MEMORY_BUDGET_BYTES,
            retainedFulltextChars: receipt.fulltextChars,
            astBlocks: receipt.astBlocks,
            markupTokens: receipt.markupTokens,
            path: ingestionPath,
          }),
        );
      }
    }
  },
  MEMORY_WORKLOAD_TIMEOUT_MS,
);

test("markup-rich documents near the cap are refused within memory headroom", async () => {
  const { receipt, peakBytes } = await runMemoryChild(SIXTEEN_MIB, "rich");
  expect(receipt.documentBytes).toBe(SIXTEEN_MIB);
  expect(receipt.budgetType).toBe("markup-budget-exceeded");
  expect(receipt.fulltextChars).toBe(0);
  expect(peakBytes).toBeLessThan(MEMORY_HEADROOM_BYTES);
  console.log(
    JSON.stringify({
      workload: "rich",
      path: "fetch",
      peakBytes,
      memoryBudgetBytes: MEMORY_BUDGET_BYTES,
    }),
  );
});

test.each(["svg", "attributes", "plaintext"])(
  "rejected %s expansion stays within memory headroom through production assembly",
  async (workload) => {
    const { receipt, peakBytes } = await runMemoryChild(256 * 1024, workload);
    expect(receipt.documentBytes).toBeLessThan(
      PL_KIO_RESPONSE_BYTE_CAP.document,
    );
    expect(receipt.budgetType).toBe("markup-budget-exceeded");
    expect(receipt.fulltextChars).toBe(0);
    expect(receipt.astBlocks).toBeNull();
    expect(receipt.rawContainsDocument).toBe(true);
    expect(peakBytes).toBeGreaterThan(0);
    expect(peakBytes).toBeLessThan(MEMORY_HEADROOM_BYTES);
    console.log(
      JSON.stringify({
        workload,
        path: "fetch",
        peakBytes,
        memoryBudgetBytes: MEMORY_BUDGET_BYTES,
      }),
    );
  },
  MEMORY_WORKLOAD_TIMEOUT_MS,
);
