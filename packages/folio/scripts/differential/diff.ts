/**
 * Differential testing harness — folio parser vs. python-docx.
 *
 * Parses a single DOCX both with folio (in-process) and python-docx
 * (subprocess), projects both into a normalised structural shape, and
 * prints any divergences. Exits 0 on equivalence, 1 on any divergence,
 * 2 on infrastructure failure (python missing, fixture missing, parse
 * error).
 *
 * Usage:
 *   bun packages/folio/scripts/differential/diff.ts <docx-path>
 *
 * See README.md in this directory for setup and rationale.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseDocx } from "../../src/core/docx/parser";
import {
  diffProjections,
  projectFolioDocument,
  type Divergence,
  type StructuralProjection,
} from "./projection";

const HERE = import.meta.dirname;
const PYTHON_SCRIPT = join(HERE, "python_docx_project.py");

const EXIT_OK = 0;
const EXIT_DIVERGED = 1;
const EXIT_INFRA = 2;

export type DifferentialResult =
  | { ok: true; folio: StructuralProjection; reference: unknown }
  | {
      ok: false;
      reason: "diverged";
      folio: StructuralProjection;
      reference: unknown;
      divergences: Divergence[];
    }
  | { ok: false; reason: "infra"; message: string };

/**
 * Run the differential comparison without exiting the process. Returns
 * a structured result so callers (the smoke test, future corpus runners)
 * can decide how to fail.
 */
export async function runDifferential(
  docxPath: string,
  options: { pythonBin?: string } = {},
): Promise<DifferentialResult> {
  const pythonBin = options.pythonBin ?? "python3";
  const resolved = resolve(docxPath);
  if (!existsSync(resolved)) {
    return {
      ok: false,
      reason: "infra",
      message: `Fixture not found: ${resolved}`,
    };
  }

  const bytes = readFileSync(resolved);
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );

  let folioProjection: StructuralProjection;
  try {
    const doc = await parseDocx(buffer);
    folioProjection = projectFolioDocument(doc);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: "infra",
      message: `folio parseDocx failed: ${message}`,
    };
  }

  const pythonResult = spawnSync(pythonBin, [PYTHON_SCRIPT, resolved], {
    encoding: "utf-8",
    timeout: 30_000,
  });
  if (pythonResult.error || pythonResult.status !== 0) {
    const stderr = pythonResult.stderr.trim();
    return {
      ok: false,
      reason: "infra",
      message: [
        `python-docx projection failed (exit ${pythonResult.status ?? "?"}).`,
        stderr ? `stderr: ${stderr}` : "",
        "Hint: pip install python-docx",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  let reference: unknown;
  try {
    reference = JSON.parse(pythonResult.stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: "infra",
      message: `Failed to parse python projector JSON: ${message}`,
    };
  }

  const divergences = diffProjections(folioProjection, reference);
  if (divergences.length === 0) {
    return { ok: true, folio: folioProjection, reference };
  }
  return {
    ok: false,
    reason: "diverged",
    folio: folioProjection,
    reference,
    divergences,
  };
}

const formatDivergences = (divergences: readonly Divergence[]): string =>
  divergences
    .map(
      (d) =>
        `  ${d.path}: folio=${JSON.stringify(d.folio)} reference=${JSON.stringify(d.reference)}`,
    )
    .join("\n");

const isMain = import.meta.path === Bun.main;
if (isMain) {
  const docxPath = process.argv[2];
  if (!docxPath) {
    console.error("usage: bun diff.ts <docx-path>");
    process.exit(EXIT_INFRA);
  }
  const result = await runDifferential(docxPath);
  if (result.ok) {
    console.log(`OK ${docxPath}`);
    console.log(JSON.stringify(result.folio, null, 2));
    process.exit(EXIT_OK);
  }
  if (result.reason === "infra") {
    console.error(result.message);
    process.exit(EXIT_INFRA);
  }
  console.error(`DIVERGED ${docxPath}`);
  console.error(formatDivergences(result.divergences));
  console.error("\nfolio projection:");
  console.error(JSON.stringify(result.folio, null, 2));
  console.error("\nreference projection:");
  console.error(JSON.stringify(result.reference, null, 2));
  process.exit(EXIT_DIVERGED);
}
