import { panic } from "better-result";
import { expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PL_KIO_HTML_BUDGET } from "@/api/handlers/case-law/ingestion/adapters/pl-kio-response-budget";

const API_ROOT = path.resolve(import.meta.dir, "../../../../..");
const MEMORY_CHILD = fileURLToPath(
  new URL("__fixtures__/pl-kio-memory-child.ts", import.meta.url),
);
const MEMORY_BUDGET_BYTES = 1024 * 1024 * 1024;
const MEMORY_WORKLOAD_TIMEOUT_MS = 180_000;
const ATTRIBUTE_FLOOD_DEADLINE_MS = 10_000;
const RESPONSE_SIZES = [256 * 1024, 1024 * 1024, PL_KIO_HTML_BUDGET.maxBytes];

const runMemoryChild = async (targetBytes: number, workload = "accepted") => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      path.join(API_ROOT, "src/tests/setup-env.ts"),
      MEMORY_CHILD,
      String(targetBytes),
      workload,
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
  const usage = child.resourceUsage() ?? panic("KIO child RSS report missing");
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
    !("targetBytes" in receipt) ||
    typeof receipt.targetBytes !== "number" ||
    !("documentBytes" in receipt) ||
    typeof receipt.documentBytes !== "number" ||
    !("fulltextChars" in receipt) ||
    typeof receipt.fulltextChars !== "number" ||
    !("astBlocks" in receipt) ||
    typeof receipt.astBlocks !== "number" ||
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
    typeof receipt.overflowBudgetType !== "string"
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
  };
  return { receipt: memoryReceipt, peakBytes: usage.maxRSS, exitCode, stderr };
};

test(
  "inline-rich KIO documents retain text, AST and raw within the worker memory headroom",
  async () => {
    for (const targetBytes of RESPONSE_SIZES) {
      const { receipt, peakBytes, exitCode, stderr } =
        await runMemoryChild(targetBytes);
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
      if (targetBytes === PL_KIO_HTML_BUDGET.maxBytes) {
        expect(receipt.markupTokens).toBeGreaterThanOrEqual(
          PL_KIO_HTML_BUDGET.maxDomAllocations * 0.9,
        );
      }
      expect(peakBytes).toBeGreaterThan(0);
      expect(peakBytes).toBeLessThan(MEMORY_BUDGET_BYTES);
      console.log(
        JSON.stringify({
          benchmark: "pl-kio-document-assembly",
          targetBytes,
          peakBytes,
          memoryBudgetBytes: MEMORY_BUDGET_BYTES,
          retainedFulltextChars: receipt.fulltextChars,
          astBlocks: receipt.astBlocks,
          markupTokens: receipt.markupTokens,
        }),
      );
    }
  },
  MEMORY_WORKLOAD_TIMEOUT_MS,
);

test.each(["svg", "attributes", "plaintext"])(
  "rejected %s expansion stays within memory headroom through production assembly",
  async (workload) => {
    const { receipt, peakBytes } = await runMemoryChild(256 * 1024, workload);
    expect(receipt.documentBytes).toBeLessThan(PL_KIO_HTML_BUDGET.maxBytes);
    expect(receipt.budgetType).toBe("markup-budget-exceeded");
    expect(receipt.fulltextChars).toBe(0);
    expect(receipt.astBlocks).toBe(0);
    expect(receipt.rawContainsDocument).toBe(true);
    expect(peakBytes).toBeGreaterThan(0);
    expect(peakBytes).toBeLessThan(MEMORY_BUDGET_BYTES);
    console.log(
      JSON.stringify({
        workload,
        peakBytes,
        memoryBudgetBytes: MEMORY_BUDGET_BYTES,
      }),
    );
  },
  MEMORY_WORKLOAD_TIMEOUT_MS,
);
