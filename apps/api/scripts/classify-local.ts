/**
 * Classify citation polarity from local text (no database).
 *
 * Runs seed regex rules against the provided text. Optionally
 * calls the LLM for unmatched citations (requires API key).
 *
 * Usage:
 *   bun apps/api/scripts/classify-local.ts --text "..."
 *   bun apps/api/scripts/classify-local.ts --file path/to/decision.txt
 *   echo "..." | bun apps/api/scripts/classify-local.ts --stdin
 *
 * Options:
 *   --text "..."       Inline text to classify
 *   --file path        Read text from a file
 *   --stdin            Read text from stdin
 *   --language cs      Language for rule selection (default: cs)
 *   --llm              Use LLM fallback (requires --citation)
 *   --citation "..."   Specific citation ref to find context for
 *                      (default: classify all seed-rule matches)
 */

import { isValidPolarity } from "@/api/handlers/case-law/polarity/consts";
import type { Polarity } from "@/api/handlers/case-law/polarity/consts";
import { SEED_RULES } from "@/api/handlers/case-law/polarity/seed-rules";

type Args = {
  text: string | null;
  file: string | null;
  stdin: boolean;
  language: string;
  llm: boolean;
  citation: string | null;
};

const parseArgs = (): Args => {
  const args = process.argv.slice(2);
  const result: Args = {
    text: null,
    file: null,
    stdin: false,
    language: "cs",
    llm: false,
    citation: null,
  };

  for (let i = 0; i < args.length; i++) {
    const next = args[i + 1];
    if (args[i] === "--text" && next) {
      result.text = next;
      i++;
    } else if (args[i] === "--file" && next) {
      result.file = next;
      i++;
    } else if (args[i] === "--stdin") {
      result.stdin = true;
    } else if (args[i] === "--language" && next) {
      result.language = next;
      i++;
    } else if (args[i] === "--llm") {
      result.llm = true;
    } else if (args[i] === "--citation" && next) {
      result.citation = next;
      i++;
    }
  }

  return result;
};

type CompiledRule = {
  pattern: string;
  regex: RegExp;
  polarity: Polarity;
  language: string;
};

const compileRules = (language: string): CompiledRule[] => {
  const rules: CompiledRule[] = [];

  for (const seed of SEED_RULES) {
    if (seed.language !== language) {
      continue;
    }
    try {
      rules.push({
        pattern: seed.pattern,
        regex: new RegExp(seed.pattern, "iu"),
        polarity: seed.polarity,
        language: seed.language,
      });
    } catch {
      console.error(`Invalid pattern: ${seed.pattern}`);
    }
  }

  return rules;
};

type Match = {
  polarity: Polarity;
  pattern: string;
  matchedText: string;
  position: number;
  context: string;
};

const findMatches = (text: string, rules: CompiledRule[]): Match[] => {
  const matches: Match[] = [];

  for (const rule of rules) {
    // Use global flag for scanning
    const global = new RegExp(rule.pattern, "giu");

    for (let m = global.exec(text); m !== null; m = global.exec(text)) {
      const start = Math.max(0, m.index - 80);
      const end = Math.min(text.length, m.index + m[0].length + 80);
      const context = text.slice(start, end);

      matches.push({
        polarity: rule.polarity,
        pattern: rule.pattern,
        matchedText: m[0],
        position: m.index,
        context,
      });
    }
  }

  // Sort by position in text
  matches.sort((a, b) => a.position - b.position);
  return matches;
};

const classifyCitationContext = (
  text: string,
  citation: string,
  rules: CompiledRule[],
): Match | null => {
  const idx = text.indexOf(citation);
  if (idx === -1) {
    console.error(`Citation "${citation}" not found in text.`);
    return null;
  }

  const start = Math.max(0, idx - 200);
  const end = Math.min(text.length, idx + citation.length + 200);
  const context = text.slice(start, end);

  for (const rule of rules) {
    if (rule.regex.test(context)) {
      const global = new RegExp(rule.pattern, "giu");
      const m = global.exec(context);
      return {
        polarity: rule.polarity,
        pattern: rule.pattern,
        matchedText: m?.[0] ?? rule.pattern,
        position: idx,
        context,
      };
    }
  }

  return null;
};

const POLARITY_COLORS: Record<Polarity, string> = {
  positive: "\u001b[32m", // green
  supportive: "\u001b[36m", // cyan
  neutral: "\u001b[33m", // yellow
  negative: "\u001b[31m", // red
  unknown: "\u001b[90m", // gray
};
const RESET = "\u001b[0m";

const printMatch = (match: Match, index: number) => {
  const color = POLARITY_COLORS[match.polarity];
  console.log(
    `\n${index + 1}. ${color}${match.polarity.toUpperCase()}${RESET}` +
      `  [${match.matchedText}]`,
  );
  console.log(`   Pattern: ${match.pattern}`);
  console.log(`   Context: ...${match.context}...`);
};

const readInput = async (args: Args): Promise<string> => {
  if (args.text) {
    return args.text;
  }

  if (args.file) {
    const file = Bun.file(args.file);
    if (!(await file.exists())) {
      console.error(`File not found: ${args.file}`);
      process.exit(1);
    }
    return file.text();
  }

  if (args.stdin) {
    const chunks: string[] = [];
    const reader = Bun.stdin.stream().getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }

    return chunks.join("");
  }

  console.error(
    "Provide input with --text, --file, or --stdin.\n\n" +
      "Usage:\n" +
      '  bun apps/api/scripts/classify-local.ts --text "..."\n' +
      "  bun apps/api/scripts/classify-local.ts --file decision.txt\n" +
      "  cat decision.txt | bun apps/api/scripts/classify-local.ts --stdin",
  );
  return process.exit(1);
};

const main = async () => {
  const args = parseArgs();
  const text = await readInput(args);

  console.log(`Language: ${args.language} | Text length: ${text.length} chars`);

  const rules = compileRules(args.language);
  console.log(`Loaded ${rules.length} seed rules for "${args.language}".`);

  // Single citation mode
  if (args.citation) {
    const match = classifyCitationContext(text, args.citation, rules);

    if (match) {
      printMatch(match, 0);
    } else {
      console.log("\nNo regex match found around the citation.");

      if (args.llm) {
        console.log("Calling LLM classifier...");
        const { classifyWithLLM } =
          await import("@/api/handlers/case-law/polarity/llm-classifier");

        const idx = text.indexOf(args.citation);
        if (idx === -1) {
          console.error(
            `Cannot classify: citation "${args.citation}" not found in text.`,
          );
          process.exit(1);
        }
        const start = Math.max(0, idx - 200);
        const end = Math.min(text.length, idx + args.citation.length + 200);
        const context = text.slice(start, end);

        const result = await classifyWithLLM(
          context,
          args.citation,
          args.language,
        );

        if (result.isErr()) {
          console.log("LLM classification failed.");
        } else {
          const color = POLARITY_COLORS[result.value.polarity];
          console.log(
            `\n${color}${result.value.polarity.toUpperCase()}${RESET}` +
              ` (confidence: ${result.value.confidence})`,
          );
          console.log(`Key phrase: "${result.value.keyPhrase}"`);
        }
      }
    }

    process.exit(0);
  }

  // Scan mode: find all rule matches in the text
  const matches = findMatches(text, rules);

  if (matches.length === 0) {
    console.log("\nNo polarity signals found in text.");

    if (args.llm) {
      console.log(
        "Note: --llm requires --citation to classify a specific citation.",
      );
    } else {
      console.log(
        'Try --llm --citation "<ref>" to classify' +
          " a specific citation with LLM.",
      );
    }

    process.exit(0);
  }

  console.log(`\nFound ${matches.length} polarity signal(s):`);

  for (const [i, match] of matches.entries()) {
    printMatch(match, i);
  }

  // Summary
  const counts: Record<string, number> = {};
  for (const m of matches) {
    counts[m.polarity] = (counts[m.polarity] ?? 0) + 1;
  }

  console.log("\nSummary:");
  for (const [polarity, count] of Object.entries(counts)) {
    if (!isValidPolarity(polarity)) {
      continue;
    }
    const color = POLARITY_COLORS[polarity];
    console.log(`  ${color}${polarity}${RESET}: ${count}`);
  }
};

main().catch((error: unknown) => {
  console.error("Classification failed:", error);
  process.exit(1);
});
