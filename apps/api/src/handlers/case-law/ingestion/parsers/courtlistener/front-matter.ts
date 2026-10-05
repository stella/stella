import type { Block } from "@stll/legal-ast/document-ast";

import { validateAndLog } from "@/api/lib/legal-search/parsers/validate-ast";

import { parseHeadmatter } from "./html";
import type { TextBudget } from "./outcome";

export type CourtListenerFrontMatter = {
  readonly headmatter?: string;
  readonly headnotes?: string;
  readonly syllabus?: string;
  readonly summary?: string;
};

type FrontMatterOutcome =
  | {
      status: "parsed";
      blocks: Block[];
      textFields: { headnotes: string; syllabus: string; summary: string };
    }
  | {
      status: "held";
      reason: "over-limit" | "requires-assets" | "no-usable-text";
    };

const APPARATUS = ["headnotes", "syllabus", "summary"] as const;

/** Semantic runs only: matching body words never suppress publisher apparatus. */
const semanticTexts = (blocks: readonly Block[], role: string): Set<string> => {
  const texts = new Set<string>();
  let run: string[] = [];
  const flush = () => {
    if (run.length > 0) {
      texts.add(run.join("\n\n"));
    }
    run = [];
  };
  for (const block of blocks) {
    if (block.type === "paragraph" && block.role === role) {
      run.push(block.plainText);
    } else {
      flush();
    }
  }
  flush();
  return texts;
};

export const composeFrontMatter = ({
  budget,
  existing,
  source,
}: {
  readonly budget: TextBudget;
  readonly existing: readonly Block[];
  readonly source: CourtListenerFrontMatter;
}): FrontMatterOutcome => {
  const blocks: Block[] = [];
  const textFields = { headnotes: "", syllabus: "", summary: "" };
  for (const field of ["headmatter", ...APPARATUS] as const) {
    const value = source[field] ?? "";
    if (value.trim() === "") {
      continue;
    }
    // The snapshot mixes plain and HTML apparatus within each column.
    const text =
      field === "headmatter"
        ? value
        : `<${field}>${/<[a-z][^>]*>/iu.test(value) ? value : Bun.escapeHTML(value)}</${field}>`;
    const parsed = parseHeadmatter({
      text,
      prefix: `cl-${field}`,
      rowType: "010combined",
      budget,
    });
    if (parsed.status !== "parsed") {
      let reason: "over-limit" | "requires-assets" | "no-usable-text";
      if (parsed.status === "over-limit") {
        reason = "over-limit";
      } else if (parsed.status === "requires-assets") {
        reason = "requires-assets";
      } else {
        reason = "no-usable-text";
      }
      return {
        status: "held",
        reason,
      };
    }
    const added = parsed.text.units.flatMap((unit) => [...unit.blocks]);
    const validation = validateAndLog(
      { parser: "courtlistener", caseNumber: `cl-${field}`, language: "en" },
      parsed.text.validationHtml,
      added,
    );
    if (!validation.ok) {
      return { status: "held", reason: "no-usable-text" };
    }
    if (field !== "headmatter") {
      const visible = added.map((block) => block.plainText).join("\n\n");
      textFields[field] = visible;
      if (semanticTexts([...blocks, ...existing], field).has(visible)) {
        continue;
      }
    }
    blocks.push(...added);
    budget.blocks += added.length;
  }
  return { status: "parsed", blocks, textFields };
};
