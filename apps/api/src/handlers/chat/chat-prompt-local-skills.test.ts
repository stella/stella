import { describe, expect, test } from "bun:test";

import type { ActiveChatSkillContext } from "@/api/handlers/chat/active-skill-context";
import {
  buildActiveSkillSection,
  buildGlobalPromptParts,
  buildLocalRunSkillCatalog,
  buildRequestedSkillsSection,
  type ChatPromptTarget,
  CLOUD_PROMPT_TARGET,
  LOCAL_RUN_SKILL_CATALOG_MAX_CHARS,
} from "@/api/handlers/chat/chat-prompt";
import { LOCAL_RUN_OUTPUTS_INSTRUCTIONS } from "@/api/handlers/chat/local-run-chunks";
import type { LocalRunSkillTool } from "@/api/handlers/chat/local-run-skills";
import { UNBOUND } from "@/api/lib/agent-skills/binding";
import {
  ACTIVE_SKILL_BODY_PROMPT_MAX_CHARS,
  type LoadedChatSkill,
} from "@/api/lib/agent-skills/skills";
import { toSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

/** The cap a run's instructions are validated against (`desktop-runner.ts`). */
const LOCAL_RUN_INSTRUCTIONS_MAX_CHARS = 65_536;

const localTarget = (
  skillTools: readonly LocalRunSkillTool[],
): ChatPromptTarget => ({
  type: "local_run",
  webSearch: "unasked",
  skillTools,
});

const builtInTool: LocalRunSkillTool = {
  name: "playbook-builder",
  toolName: "skill__playbook_builder",
  description: "Builds a review playbook from the firm's positions.",
  source: "built-in",
};
const teamTool: LocalRunSkillTool = {
  name: "nda-review",
  toolName: "skill__nda_review",
  description: "Reviews an NDA against the firm's fallback positions.",
  source: "installed",
};

const catalogToolNames = (text: string) =>
  [...text.matchAll(/^- (skill__[a-z0-9_]+)/gmu)].map((match) => match[1]);

const loadedSkill = (
  overrides: Partial<LoadedChatSkill> & Pick<LoadedChatSkill, "name">,
): LoadedChatSkill => ({
  body: "Apply the firm's positions.",
  compatibility: null,
  contentHash: null,
  description: "A skill",
  id: toSafeId<"agentSkill">("skill_requested"),
  license: null,
  metadata: {},
  origin: "authored",
  resources: [{ path: "references/positions.md" }],
  source: "installed",
  version: null,
  ...overrides,
});

describe("skills on a run on the member's computer", () => {
  test("lists each skill by the MCP tool that serves it: built-ins in the stable prefix, installed ones in the user tail", () => {
    const parts = buildGlobalPromptParts({
      promptTarget: localTarget([teamTool, builtInTool]),
      userContext: null,
    });

    expect(parts.cacheStablePrefix).toContain("STELLA SKILLS:");
    expect(parts.cacheStablePrefix).toContain(
      `- skill__playbook_builder: ${builtInTool.description}`,
    );
    expect(parts.cacheStablePrefix).not.toContain("skill__nda_review");
    expect(parts.untrustedSuffix).toContain(
      `- skill__nda_review: ${teamTool.description}`,
    );
    expect(catalogToolNames(parts.fullPrompt).toSorted()).toEqual(
      [builtInTool.toolName, teamTool.toolName].toSorted(),
    );
    for (const cloudOnly of ["load-skill", "read-skill-resource"]) {
      expect(parts.fullPrompt).not.toContain(cloudOnly);
    }
  });

  test("a run with no skills gets no skill section", () => {
    const parts = buildGlobalPromptParts({
      promptTarget: localTarget([]),
      userContext: null,
    });
    expect(parts.fullPrompt).not.toContain("STELLA SKILLS:");
  });

  test("names every skill within the budget, shortening descriptions before dropping any", () => {
    const skillTools = Array.from(
      { length: LIMITS.agentSkillsChatMetadataMax },
      (_, index): LocalRunSkillTool => ({
        name: `team-skill-${String(index)}`,
        toolName: `skill__team_skill_${String(index)}`,
        description: `Skill ${String(index)} ${"does careful legal work ".repeat(60)}`,
        source: "installed",
      }),
    );
    const catalog = buildLocalRunSkillCatalog([builtInTool, ...skillTools]);
    const text = `${catalog.builtIn}\n${catalog.installed}`;

    expect(text.length).toBeLessThanOrEqual(LOCAL_RUN_SKILL_CATALOG_MAX_CHARS);
    expect(catalogToolNames(text)).toHaveLength(skillTools.length + 1);
    // Still a description per skill, cut at a word and marked.
    expect(catalog.installed).toContain("- skill__team_skill_7: Skill 7 does");
    expect(catalog.installed).toContain("…");
    expect(catalog.installed).not.toContain("did not fit");
  });

  test("200 skills with the longest names and descriptions keep the run's instructions under the cap", () => {
    const skillTools = Array.from(
      { length: LIMITS.agentSkillsChatMetadataMax },
      (_, index): LocalRunSkillTool => ({
        name: `s${String(index)}`,
        toolName: `skill__${String(index).padStart(3, "0")}_${"x".repeat(53)}`,
        description: "d".repeat(LIMITS.agentSkillDescriptionMaxChars),
        source: "installed",
      }),
    );
    const parts = buildGlobalPromptParts({
      promptTarget: localTarget([builtInTool, ...skillTools]),
      userContext: null,
    });
    const instructions = `${parts.fullPrompt}\n\n${LOCAL_RUN_OUTPUTS_INSTRUCTIONS}`;
    const catalog = buildLocalRunSkillCatalog([builtInTool, ...skillTools]);

    expect(
      `${catalog.builtIn}\n${catalog.installed}`.length,
    ).toBeLessThanOrEqual(LOCAL_RUN_SKILL_CATALOG_MAX_CHARS);
    expect(instructions.length).toBeLessThan(LOCAL_RUN_INSTRUCTIONS_MAX_CHARS);
    // Every listed skill is named by its tool; any past the budget are
    // counted, never silently dropped.
    const listed = catalogToolNames(catalog.installed).length;
    const omitted = skillTools.length - listed;
    if (omitted > 0) {
      expect(catalog.installed).toContain(
        `${String(omitted)} more skills did not fit in this list`,
      );
    }
  });

  test("requested skills name the skill's MCP tool, never load-skill", () => {
    const section = buildRequestedSkillsSection(
      {
        loaded: [
          loadedSkill({
            name: "nda-review",
            body: "x".repeat(ACTIVE_SKILL_BODY_PROMPT_MAX_CHARS + 10),
          }),
          loadedSkill({ name: "matter-method" }),
        ],
        notPreloaded: ["nda-review", "manual-only"],
        unavailable: ["gone"],
      },
      localTarget([teamTool]),
    );

    expect(section).not.toContain("load-skill");
    expect(section).not.toContain("read-skill-resource");
    expect(section).toContain(
      "read each by calling the stella MCP tool skill__nda_review with `resource` set to its path",
    );
    expect(section).toContain(
      "call the stella MCP tool skill__nda_review for the rest",
    );
    // A preloaded skill its MCP server does not serve: work from the text.
    expect(section).toContain("this run cannot read them");
    expect(section).toContain(
      "call each one's stella MCP tool before answering: skill__nda_review.",
    );
    expect(section).toContain(
      "not available in this run (removed, disabled, not shared with the user, or needing a tool this run does not have): gone, manual-only.",
    );
  });

  test("the cloud chat's requested skills keep load-skill", () => {
    const requested = {
      loaded: [loadedSkill({ name: "nda-review" })],
      notPreloaded: ["later"],
      unavailable: ["gone"],
    };
    const section = buildRequestedSkillsSection(requested);

    expect(buildRequestedSkillsSection(requested, CLOUD_PROMPT_TARGET)).toBe(
      section,
    );
    expect(section).toContain("as `load-skill` would return them");
    expect(section).toContain("Files (read with read-skill-resource):");
    expect(section).toContain(
      "call load-skill for each before answering: later.",
    );
    expect(section).toContain("not available in this chat");
  });

  test("the active skill points at its MCP tool and is read-only", () => {
    const activeSkill = {
      binding: UNBOUND,
      body: "# Skill body",
      description: "Active workflow description.",
      displayName: "NDA review",
      editable: true,
      documentedChatReads: [],
      excludedChatTools: [],
      id: toSafeId<"agentSkill">("skill_active"),
      origin: "authored",
      requiredTools: [],
      resources: [{ path: "references/checklist.md" }],
      source: "installed",
      toolName: "nda-review",
      version: null,
    } satisfies ActiveChatSkillContext;

    const section = buildActiveSkillSection(
      activeSkill,
      [],
      localTarget([teamTool]),
    );

    expect(section).not.toContain("load-skill");
    expect(section).toContain("Its stella MCP tool is skill__nda_review");
    expect(section).toContain("read-only in this run");
    expect(section).toContain("- references/checklist.md");
  });
});
