import { describe, expect, test } from "bun:test";

import {
  rebaseSkillMetadataDraft,
  type SkillMetadataDraft,
  skillMetadataDraft,
} from "@/routes/knowledge/-components/skill-metadata-draft.logic";

const SKILL_ID = "0199a1b2-0000-7000-8000-000000000001";

const previous = {
  command: null,
  description: "Reviews an agreement against the checklist.",
  enabled: false,
  id: SKILL_ID,
  invocation: "auto" as const,
  name: "check-against-rules",
};

// What the server returns after another field was saved or changed elsewhere:
// every field differs from `previous`, so each can show which side won.
const next = {
  command: "house-rules",
  description: "Checks clauses against the house rules.",
  enabled: true,
  id: SKILL_ID,
  invocation: "manual" as const,
  name: "Clause review",
};

// Unsaved edits. Each text differs from both snapshots; a two-valued edit can
// only match one of them.
const edits: SkillMetadataDraft = {
  command: "my-review",
  description: "Typed but not yet saved.",
  enabled: true,
  invocation: "manual",
  name: "Typed name",
};

const FIELDS = Object.keys(edits).filter(
  (field): field is keyof SkillMetadataDraft => Object.hasOwn(edits, field),
);

// Every combination of edited fields.
const editedFieldSets: (typeof FIELDS)[number][][] = [[]];
for (const field of FIELDS) {
  for (const set of editedFieldSets.slice()) {
    editedFieldSets.push([...set, field]);
  }
}

describe("rebasing the skill editor draft onto a new snapshot", () => {
  test("keeps edited fields and takes the new snapshot for the rest", () => {
    const shown = skillMetadataDraft(previous);
    const incoming = skillMetadataDraft(next);
    for (const field of FIELDS) {
      expect(edits[field]).not.toBe(shown[field]);
      expect(shown[field]).not.toBe(incoming[field]);
    }
    expect(editedFieldSets).toHaveLength(2 ** FIELDS.length);

    for (const edited of editedFieldSets) {
      const draft = { ...shown };
      for (const field of edited) {
        Object.assign(draft, { [field]: edits[field] });
      }

      const rebased = rebaseSkillMetadataDraft({ draft, next, previous });

      for (const field of FIELDS) {
        expect({ edited, field, value: rebased[field] }).toEqual({
          edited,
          field,
          value: edited.includes(field) ? edits[field] : incoming[field],
        });
      }
    }
  });

  test("an unedited default command follows a renamed skill", () => {
    const draft = skillMetadataDraft(previous);
    const rebased = rebaseSkillMetadataDraft({
      draft: { ...draft, name: "Clause review" },
      next: { ...previous, name: "Clause review" },
      previous,
    });
    expect(rebased.command).toBe("clause-review");
  });

  test("a snapshot of another skill replaces the draft", () => {
    const other = { ...next, id: "0199a1b2-0000-7000-8000-000000000002" };
    const rebased = rebaseSkillMetadataDraft({
      draft: edits,
      next: other,
      previous,
    });
    expect(rebased).toEqual(skillMetadataDraft(other));
  });
});

describe("suggesting a command from the skill name", () => {
  const suggested = (name: string) =>
    skillMetadataDraft({ ...previous, command: null, name }).command;

  test.each([
    ["Clause review", "clause-review"],
    ["Česká dovednost", "ceska-dovednost"],
    ["Prüfung der Verträge", "prufung-der-vertrage"],
    ["Révision des clauses", "revision-des-clauses"],
    ["İstanbul Sözleşme İncelemesi", "istanbul-sozlesme-incelemesi"],
    ["  --Rules!!  ", "rules"],
    ["契約書", ""],
  ])("%s becomes %s", (name, command) => {
    expect(suggested(name)).toBe(command);
  });

  test("stays within the API's 49-character command limit", () => {
    const command = suggested(`${"word ".repeat(30)}end`);
    expect(command.length).toBeLessThanOrEqual(49);
    expect(command).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
  });
});
