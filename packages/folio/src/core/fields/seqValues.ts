import { parseFieldInstruction } from "../docx/fieldParser";
import type { FlowBlock } from "../layout-engine/types";

/**
 * Assign each SEQ field instance its sequence number in document order, keyed by
 * the field run's `pmStart`. SEQ counters are per identifier (the field
 * argument, e.g. `Figure`), so `SEQ Figure` and `SEQ Table` count
 * independently. Honours `\r n` (reset to n) and `\c` (repeat current without
 * advancing); every other SEQ advances its counter by one. Independent of
 * pagination, so it runs once per document, not per layout pass.
 */
export function buildSeqValues(
  blocks: readonly FlowBlock[],
): Map<number, number> {
  const counters = new Map<string, number>();
  const values = new Map<number, number>();
  walkBlocks(blocks, counters, values);
  return values;
}

function walkBlocks(
  blocks: readonly FlowBlock[],
  counters: Map<string, number>,
  values: Map<number, number>,
): void {
  for (const block of blocks) {
    if (block.kind === "paragraph") {
      for (const run of block.runs) {
        if (run.kind !== "field" || run.pmStart === undefined) {
          continue;
        }
        const parsed = parseFieldInstruction(run.instruction || run.fieldType);
        if (parsed.type !== "SEQ") {
          continue;
        }
        const id = parsed.argument ?? "";
        const reset = parsed.switches.find(
          (s) => s.switch.toLowerCase() === "r",
        )?.value;
        const repeat = parsed.switches.some(
          (s) => s.switch.toLowerCase() === "c",
        );

        let value: number;
        if (reset !== undefined) {
          value = Number.parseInt(reset, 10) || 1;
        } else if (repeat) {
          value = counters.get(id) ?? 0;
        } else {
          value = (counters.get(id) ?? 0) + 1;
        }

        counters.set(id, value);
        values.set(run.pmStart, value);
      }
    } else if (block.kind === "table") {
      for (const row of block.rows) {
        for (const cell of row.cells) {
          walkBlocks(cell.blocks, counters, values);
        }
      }
    }
  }
}
