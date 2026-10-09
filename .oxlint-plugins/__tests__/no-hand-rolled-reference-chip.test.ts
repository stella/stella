import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const lint = async (
  lines: readonly string[],
  sourcePath = "apps/web/src/components/chat/some-chip.tsx",
) =>
  await lintSingleRule(
    "no-hand-rolled-reference-chip",
    [...lines, ""].join("\n"),
    { sourcePath },
  );

const HAND_ROLLED_CHIP = [
  'import { InlinePill } from "@/components/inline-pill";',
  'import { EntityIcon as Glyph } from "@/components/workspaces/entity-kind-icon";',
  "declare const label: string;",
  'const icon = <Glyph source={{ type: "unknown" }} />;',
  "export const Chip = () => <InlinePill leadingIcon={icon}>{label}</InlinePill>;",
] as const;

describe.serial("no-hand-rolled-reference-chip", () => {
  test("reports a reference glyph in a file that renders a chip shell, through aliases and variables", async () => {
    expect(await lint(HAND_ROLLED_CHIP)).toEqual([4]);
  });

  test("reports a composer node view that draws a reference glyph", async () => {
    expect(
      await lint([
        'import { NodeViewWrapper } from "@tiptap/react";',
        'import { SkillIcon } from "@stll/ui/icons";',
        "export const Node = () => (",
        "  <NodeViewWrapper>",
        "    <SkillIcon />",
        "  </NodeViewWrapper>",
        ");",
      ]),
    ).toEqual([5]);
  });

  test("reports the href codec and hand-spelled reference hrefs", async () => {
    expect(
      await lint([
        'import { toChatResourceHref } from "@stll/api-contract";',
        "declare const id: string;",
        `export const a = \`#stella-workspace=\${id}\`;`,
        'export const b = "#stella-decision-passage=x:p-1";',
        "export const c = toChatResourceHref;",
      ]),
    ).toEqual([1, 3, 4]);
  });

  test("accepts glyphs without a shell, shells without a glyph, and type-only codec imports", async () => {
    expect(
      await lint([
        'import type { ChatMentionResourceHref } from "@stll/api-contract";',
        'import { MatterIcon } from "@stll/ui/matter-icon";',
        "declare const id: string;",
        "declare const href: ChatMentionResourceHref;",
        "export const Row = () => <MatterIcon matter={{ id, color: null }} />;",
        'export const links = [href, "#folio:seq-1", "#stella-skill-ref=x"];',
      ]),
    ).toEqual([]);
    expect(
      await lint([
        'import { InlinePill } from "@/components/inline-pill";',
        'import { FileTextIcon } from "@stll/ui/icons";',
        "export const Citation = () => (",
        "  <InlinePill leadingIcon={<FileTextIcon />}>1</InlinePill>",
        ");",
      ]),
    ).toEqual([]);
  });

  test("leaves the references module and tests alone", async () => {
    expect(
      await lint(
        HAND_ROLLED_CHIP,
        "apps/web/src/components/references/reference-chip.tsx",
      ),
    ).toEqual([]);
    expect(
      await lint(
        HAND_ROLLED_CHIP,
        "apps/web/src/components/chat/some-chip.test.tsx",
      ),
    ).toEqual([]);
  });
});
