import { describe, expect, test } from "bun:test";

import { parseSkillFile } from "./frontmatter";
import {
  readSkillRequiredTools,
  SKILL_REQUIRED_TOOLS_METADATA_KEY,
} from "./required-tools";

const metadataOf = (source: string) => {
  const parsed = parseSkillFile(source);
  if (parsed.isErr()) {
    throw parsed.error;
  }
  return parsed.value.metadata.metadata;
};

describe("required tools frontmatter", () => {
  test("reads a whitespace-separated list, deduplicated in declared order", () => {
    const metadata = metadataOf(`---
name: playbook-builder
description: Builds a playbook.
metadata:
  ${SKILL_REQUIRED_TOOLS_METADATA_KEY}: "save_playbook   list_playbooks\tsave_playbook"
---

Body.`);

    expect(readSkillRequiredTools(metadata)).toEqual([
      "save_playbook",
      "list_playbooks",
    ]);
  });

  test("requires nothing when the key is absent or blank", () => {
    const absent = metadataOf(`---
name: plain-skill
description: Needs nothing.
metadata:
  author: stella
---

Body.`);

    expect(readSkillRequiredTools(absent)).toEqual([]);
    expect(
      readSkillRequiredTools({ [SKILL_REQUIRED_TOOLS_METADATA_KEY]: "  " }),
    ).toEqual([]);
    expect(readSkillRequiredTools(undefined)).toEqual([]);
    expect(readSkillRequiredTools(null)).toEqual([]);
  });
});
