import { describe, expect, test } from "bun:test";

import { parseSkillDraft, skillDraftTexts } from "./draft-package";

const skillMd = (body: string) =>
  `---\nname: delay-claim-reply\ndescription: Reply to a passenger's delay claim the way this firm does.\n---\n\n${body}\n`;

describe("a skill draft", () => {
  test("a fenced SKILL.md and its files become one skill package", () => {
    const { draft, parsed } = parseSkillDraft({
      markdown: `\`\`\`markdown\n${skillMd("# Delay claim reply")}\`\`\``,
      resources: [
        {
          path: "references/defences.md",
          content: "# Defences\n\n- Extraordinary circumstances need evidence.",
        },
      ],
    });
    expect(draft.markdown.startsWith("---\nname: delay-claim-reply")).toBe(
      true,
    );
    const skill = parsed.unwrap("a valid draft parses");
    expect(skill.name).toBe("delay-claim-reply");
    expect(skill.resources.map(({ path }) => path)).toEqual([
      "references/defences.md",
    ]);
  });

  test("a file outside the skill's folders is dropped, not stored", () => {
    const { draft } = parseSkillDraft({
      markdown: skillMd("# Delay claim reply"),
      resources: [{ path: "../outside.md", content: "x" }],
    });
    expect(draft.resources).toEqual([]);
  });

  test("a draft without frontmatter is not a skill", () => {
    const { parsed } = parseSkillDraft({
      markdown: "# Just a heading",
      resources: [],
    });
    expect(parsed.isErr()).toBe(true);
  });

  test("names are looked for in SKILL.md, in file paths and in files", () => {
    expect(
      skillDraftTexts({
        markdown: "A",
        resources: [{ path: "references/b.md", content: "C" }],
      }),
    ).toEqual(["A", "references/b.md", "C"]);
  });
});
