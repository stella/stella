import { describe, expect, test } from "bun:test";
import * as lucide from "lucide-react";
import { readFileSync } from "node:fs";
import path from "node:path";

import * as icons from "./icons";

// A semantic entry is a hand-written `export { Glyph as Name } from
// "lucide-react";` with the comment lines above it (its reason, and a
// `sharedOnPurpose:` line when it deliberately shares a glyph).
type SemanticEntry = {
  readonly name: string;
  readonly glyph: string;
  readonly comments: readonly string[];
};

const SEMANTIC_EXPORT =
  /^export \{ (?<glyph>\w+) as (?<name>\w+) \} from "lucide-react";$/u;

const parseSemanticEntries = (source: string): SemanticEntry[] => {
  const entries: SemanticEntry[] = [];
  let comments: string[] = [];
  for (const line of source.split("\n")) {
    const match = SEMANTIC_EXPORT.exec(line);
    if (match?.groups !== undefined) {
      entries.push({
        name: match.groups["name"] ?? "",
        glyph: match.groups["glyph"] ?? "",
        comments,
      });
      comments = [];
    } else if (line.startsWith("//")) {
      comments.push(line.replace(/^\/\/\s?/u, ""));
    } else {
      comments = [];
    }
  }
  return entries;
};

const sharedWith = (entry: SemanticEntry): string | null => {
  for (const comment of entry.comments) {
    const match = /^sharedOnPurpose: (?<other>\w+)\b/u.exec(comment);
    if (match?.groups?.["other"] !== undefined) {
      return match.groups["other"];
    }
  }
  return null;
};

const glyphComponent = (name: string): unknown =>
  Reflect.get(lucide, name) as unknown;

/**
 * Every problem with the semantic entries: an entry without a reason, and
 * two entries drawing the same lucide glyph (compared by component, so a
 * lucide alias counts) unless one names the other in `sharedOnPurpose:`.
 */
const semanticEntryProblems = (source: string): string[] => {
  const entries = parseSemanticEntries(source);
  const problems: string[] = [];
  for (const entry of entries) {
    if (
      !entry.comments.some((comment) => !comment.startsWith("sharedOnPurpose:"))
    ) {
      problems.push(`${entry.name} has no one-line reason above it`);
    }
  }
  for (const [index, entry] of entries.entries()) {
    for (const other of entries.slice(index + 1)) {
      if (glyphComponent(entry.glyph) !== glyphComponent(other.glyph)) {
        continue;
      }
      if (
        sharedWith(other) !== entry.name &&
        sharedWith(entry) !== other.name
      ) {
        problems.push(
          `${entry.name} and ${other.name} both draw ${entry.glyph} without a sharedOnPurpose note`,
        );
      }
    }
  }
  return problems;
};

const ICONS_SOURCE = readFileSync(
  path.join(import.meta.dir, "icons.ts"),
  "utf-8",
);

describe("icon module", () => {
  test("declares the semantic entries it is known for", () => {
    const names = parseSemanticEntries(ICONS_SOURCE).map((entry) => entry.name);
    expect(names).toContain("SkillIcon");
    expect(names).toContain("AiActionIcon");
    expect(icons.SkillIcon).toBe(lucide.BookOpenIcon);
    expect(icons.AiActionIcon).toBe(lucide.WandSparklesIcon);
    expect(icons.NewChatIcon).toBe(lucide.MessageSquarePlusIcon);
    expect(icons.AddCommentIcon).toBe(lucide.MessageSquareQuoteIcon);
  });

  test("gives every semantic entry a reason and its own glyph unless shared on purpose", () => {
    expect(semanticEntryProblems(ICONS_SOURCE)).toEqual([]);
  });

  test("never also exports a semantic entry's glyph under its plain name", () => {
    const semantic = new Set(
      parseSemanticEntries(ICONS_SOURCE).map((entry) => entry.name),
    );
    const semanticComponents = new Set(
      [...semantic].map((name) => Reflect.get(icons, name) as unknown),
    );
    const plainDuplicates = Object.entries(icons)
      .filter(
        ([name, value]) => !semantic.has(name) && semanticComponents.has(value),
      )
      .map(([name]) => name);
    expect(plainDuplicates).toEqual([]);
  });

  test("reports two semantic entries that share a glyph silently", () => {
    const source = [
      "// A skill is saved instructions.",
      'export { BookOpenIcon as SkillIcon } from "lucide-react";',
      "// The case-law section.",
      'export { BookOpenIcon as CaseLawIcon } from "lucide-react";',
      "// An alias of the same glyph is the same glyph.",
      'export { LucideBookOpen as ManualIcon } from "lucide-react";',
      'export { WandSparklesIcon as AiActionIcon } from "lucide-react";',
    ].join("\n");
    expect(semanticEntryProblems(source)).toEqual([
      "AiActionIcon has no one-line reason above it",
      "SkillIcon and CaseLawIcon both draw BookOpenIcon without a sharedOnPurpose note",
      "SkillIcon and ManualIcon both draw BookOpenIcon without a sharedOnPurpose note",
      "CaseLawIcon and ManualIcon both draw BookOpenIcon without a sharedOnPurpose note",
    ]);
  });

  test("accepts a shared glyph that names its partner", () => {
    const source = [
      "// A skill is saved instructions.",
      'export { BookOpenIcon as SkillIcon } from "lucide-react";',
      "// The case-law section.",
      "// sharedOnPurpose: SkillIcon, pending a separate glyph.",
      'export { BookOpenIcon as CaseLawIcon } from "lucide-react";',
    ].join("\n");
    expect(semanticEntryProblems(source)).toEqual([]);
  });
});
