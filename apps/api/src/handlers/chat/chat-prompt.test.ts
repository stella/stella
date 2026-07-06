import { describe, expect, test } from "bun:test";

import { createChatAttachmentPart } from "@/api/handlers/chat/chat-message-parts";
import { createChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import { toSafeId } from "@/api/lib/branded-types";
import { DOCX_REVIEW_MARKUP_EXAMPLES } from "@/api/lib/docx-review-markup";

import {
  appendAnonymizedModeHintToChatSafePrompt,
  appendActiveFilePromptIfEntityExists,
  buildActiveSkillSection,
  buildActiveTemplatePrompt,
  buildChatPromptCacheKey,
  buildGlobalPrompt,
  buildGlobalPromptParts,
  buildUserContextBlock,
  buildWorkspacePromptParts,
  buildWorkspacePromptText,
  extractTitle,
} from "./chat-prompt";
import type {
  ChatCacheStablePrefix,
  ChatSafePrompt,
  ChatToolAvailability,
  ChatUntrustedPromptSuffix,
} from "./chat-prompt";
import {
  ACTIVE_SKILL_BODY_PROMPT_MAX_CHARS,
  type ActiveChatSkillContext,
} from "./skills";
import {
  FETCH_URL_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from "./tools/web-search-tools";
import type { ChatMessage } from "./types";

const WORKSPACE_ID = toSafeId<"workspace">("ws_prompt_test");
const FULL_TOOL_AVAILABILITY = {
  templateAuthoring: true,
  webResearch: true,
} as const satisfies ChatToolAvailability;
const SKILL_METADATA = [
  {
    name: "legal-interpretation",
    description: "Analyze legal texts using an interpretation framework.",
    version: "3.0",
  },
] as const;

describe("chat prompt builders", () => {
  test("workspace prompt anchors on the matter without listing properties", () => {
    const refRegistry = createChatRefRegistry();
    const prompt = buildWorkspacePromptText({
      entityCount: 42,
      refRegistry,
      userContext: null,
      workspaceId: WORKSPACE_ID,
      workspaceName: "Matter Alpha",
    });

    expect(prompt).toContain('Connected to matter "Matter Alpha"');
    expect(prompt).toContain("42 entities");
    // Property + entity refs are never preloaded — the model must
    // discover them via tools.
    expect(prompt).not.toContain("Available metadata columns");
    expect(prompt).not.toContain("ref: prop_");
    expect(prompt).not.toContain("Status");
  });

  test("system prompts include the code-mode read surface", () => {
    const refRegistry = createChatRefRegistry();
    const workspacePrompt = buildWorkspacePromptText({
      entityCount: 1,
      refRegistry,
      userContext: null,
      workspaceId: WORKSPACE_ID,
      workspaceName: "Matter Alpha",
    });
    const globalPrompt = buildGlobalPrompt({
      skillMetadata: SKILL_METADATA,
      userContext: null,
    });

    for (const prompt of [workspacePrompt, globalPrompt]) {
      expect(prompt).toContain("ASK-USER BOUNDARY");
      expect(prompt).toContain(
        "Never use it to request tool-call permission or consent",
      );
      // Code-mode surface: the sandbox runner and its discovery companion.
      expect(prompt).toContain("execute_typescript");
      expect(prompt).toContain("discover_tools");
      // Only the entry-point read is documented eagerly; the rest are held
      // out of the eager catalog and reached via discover_tools, keeping the
      // injected section in the same size class as the old compact hint.
      expect(prompt).toContain("declare function external_list_matters");
      expect(prompt).toContain("### Discoverable APIs");
      expect(prompt).toContain("external_search_across_matters");
      expect(prompt).not.toContain("declare function external_list_invoices");
      expect(prompt).toContain("DOCX REVIEW TAGS");
      expect(prompt).toContain(DOCX_REVIEW_MARKUP_EXAMPLES.insertion);
      expect(prompt).toContain(DOCX_REVIEW_MARKUP_EXAMPLES.deletion);
      expect(prompt).toContain(DOCX_REVIEW_MARKUP_EXAMPLES.comment);
      // The retired hand-written catalog and its tools are gone.
      expect(prompt).not.toContain("For stella data reads, use the stella API");
      expect(prompt).not.toContain("run-stella-query");
    }
  });

  test("renders UI locale as a BCP-47 cue so the model anchors language to it", () => {
    const prompt = buildUserContextBlock({
      locale: "cs",
      timezone: "Europe/Prague",
      userName: "Jan Kubica",
    });

    expect(prompt).toContain("User registered as: Jan Kubica");
    expect(prompt).toContain("User UI language (BCP-47): cs");
    // Day granularity only: a minute-precise timestamp would change
    // the prompt on every request and defeat prompt caching.
    expect(prompt).toContain("Current date:");
    expect(prompt).not.toMatch(/Current date:[^\n]*\d{1,2}:\d{2}/u);
  });

  test("keeps the cache-stable prefix independent from volatile user context", () => {
    const first = buildGlobalPromptParts({
      skillMetadata: SKILL_METADATA,
      userContext: {
        locale: "en",
        timezone: "Europe/Prague",
        userName: "First User",
      },
    });
    const second = buildGlobalPromptParts({
      skillMetadata: SKILL_METADATA,
      userContext: {
        locale: "cs",
        timezone: "Europe/Prague",
        userName: "Second User",
      },
    });

    expect(first.cacheStablePrefix).toBe(second.cacheStablePrefix);
    expect(first.cacheStablePrefix).toContain("legal-interpretation");
    expect(first.cacheStablePrefix).not.toContain("First User");
    expect(first.cacheStablePrefix).not.toContain("Current date");
    expect(first.fullPrompt).not.toBe(second.fullPrompt);
    expect(buildChatPromptCacheKey(first.cacheStablePrefix)).toBe(
      buildChatPromptCacheKey(second.cacheStablePrefix),
    );
  });

  test("brands assembled prompt parts at compile time", () => {
    const prompt = buildGlobalPromptParts({
      skillMetadata: SKILL_METADATA,
      userContext: null,
    });
    const acceptsCacheStablePrefix = (value: ChatCacheStablePrefix) => value;
    const acceptsSafePrompt = (value: ChatSafePrompt) => value;
    const acceptsUntrustedSuffix = (value: ChatUntrustedPromptSuffix) => value;

    expect(acceptsCacheStablePrefix(prompt.cacheStablePrefix)).toBe(
      prompt.cacheStablePrefix,
    );
    expect(acceptsSafePrompt(prompt.safePrompt)).toBe(prompt.safePrompt);
    expect(acceptsUntrustedSuffix(prompt.untrustedSuffix)).toBe(
      prompt.untrustedSuffix,
    );

    // @ts-expect-error plain strings must not be accepted as cache-stable prefixes
    buildChatPromptCacheKey("raw prompt text");
    // @ts-expect-error prompt parts are not interchangeable
    acceptsSafePrompt(prompt.untrustedSuffix);
    // @ts-expect-error prompt parts are not interchangeable
    acceptsUntrustedSuffix(prompt.safePrompt);
  });

  test("keeps anonymized-mode guidance in the safe prompt half", () => {
    const prompt = buildGlobalPromptParts({
      skillMetadata: SKILL_METADATA,
      userContext: null,
    });
    const extended = appendAnonymizedModeHintToChatSafePrompt(
      prompt.safePrompt,
    );
    const acceptsSafePrompt = (value: ChatSafePrompt) => value;

    expect(acceptsSafePrompt(extended)).toBe(extended);
    expect(extended).toContain(prompt.safePrompt);
    expect(extended).toContain("ANONYMIZED MODE");
    expect(extended).toContain("External (non-stella) tools");
  });

  test("routes installed skill metadata through the untrusted suffix", () => {
    const prompt = buildGlobalPromptParts({
      skillMetadata: [
        {
          description: "Use the Acme acquisition playbook.",
          displayName: "Acme Acquisition Review",
          name: "acme-acquisition-review",
          source: "installed",
          version: null,
        },
      ],
      userContext: null,
    });

    expect(prompt.cacheStablePrefix).not.toContain("acme-acquisition-review");
    expect(prompt.safePrompt).not.toContain("Acme acquisition");
    expect(prompt.untrustedSuffix).toContain(
      "Acme Acquisition Review (skillName: acme-acquisition-review)",
    );
    expect(prompt.untrustedSuffix).toContain("Acme acquisition");
    expect(prompt.fullPrompt).toContain("acme-acquisition-review");
  });

  test("active skill section anchors this skill and its editable files", () => {
    const activeSkill = {
      body: "# Skill body\nUse the active workflow.",
      description: "Active workflow description.",
      displayName: "Active Workflow",
      editable: true,
      id: toSafeId<"agentSkill">("skill_active"),
      origin: "authored",
      resources: [{ kind: "knowledge", path: "knowledge/checklist.md" }],
      source: "installed",
      toolName: "active-workflow",
      version: "1.0",
    } satisfies ActiveChatSkillContext;

    const section = buildActiveSkillSection(activeSkill);

    expect(section).toContain("The user is currently inside this stella skill");
    expect(section).toContain("Display name: Active Workflow");
    expect(section).toContain(
      "Canonical skill name for load-skill/read-skill-resource: active-workflow",
    );
    expect(section).toContain('When the user says "this skill"');
    expect(section).toContain("This skill is editable in this chat");
    expect(section).toContain("- knowledge/checklist.md (knowledge)");
    expect(section).toContain("# Skill body");
  });

  test("marks long active skill bodies as truncated", () => {
    const hiddenTail = "tail that must not be treated as visible";
    const activeSkill = {
      body: `${"a".repeat(ACTIVE_SKILL_BODY_PROMPT_MAX_CHARS)}${hiddenTail}`,
      description: "Active workflow description.",
      displayName: "Active Workflow",
      editable: true,
      id: toSafeId<"agentSkill">("skill_active"),
      origin: "authored",
      resources: [],
      source: "installed",
      toolName: "active-workflow",
      version: null,
    } satisfies ActiveChatSkillContext;

    const section = buildActiveSkillSection(activeSkill);

    expect(section).toContain("Current SKILL.md body prefix");
    expect(section).toContain("full-body replacement tool is unavailable");
    expect(section).not.toContain(hiddenTail);
  });

  test("keeps the cache-stable prefix independent from workspace context", () => {
    const firstRefRegistry = createChatRefRegistry();
    const secondRefRegistry = createChatRefRegistry();
    const first = buildWorkspacePromptParts({
      entityCount: 1,
      refRegistry: firstRefRegistry,
      skillMetadata: SKILL_METADATA,
      userContext: null,
      workspaceId: WORKSPACE_ID,
      workspaceName: "Matter Alpha",
    });
    const second = buildWorkspacePromptParts({
      entityCount: 500,
      refRegistry: secondRefRegistry,
      skillMetadata: SKILL_METADATA,
      userContext: null,
      workspaceId: toSafeId<"workspace">("ws_prompt_other"),
      workspaceName: "Matter Beta",
    });

    expect(first.cacheStablePrefix).toBe(second.cacheStablePrefix);
    expect(first.cacheStablePrefix).not.toContain("Matter Alpha");
    expect(first.fullPrompt).toContain("Matter Alpha");
    expect(second.fullPrompt).toContain("Matter Beta");
    expect(buildChatPromptCacheKey(first.cacheStablePrefix)).toBe(
      buildChatPromptCacheKey(second.cacheStablePrefix),
    );
  });

  test("omits empty skill catalog sections cleanly", () => {
    const prompt = buildGlobalPromptParts({
      skillMetadata: [],
      userContext: null,
    });

    expect(prompt.cacheStablePrefix).not.toContain("Available stella skills");
    expect(prompt.cacheStablePrefix).not.toContain("\n\n\n\n");
    expect(prompt.fullPrompt).not.toContain("\n\n\n\n");
  });

  test("appends the active-file prompt only when the entity exists", () => {
    const basePrompt = "Base prompt";
    const refRegistry = createChatRefRegistry();
    const activeFile = {
      entityId: toSafeId<"entity">("entity_active"),
      fileName: "Open file.pdf",
    };

    expect(
      appendActiveFilePromptIfEntityExists({
        activeFile,
        entityExists: false,
        prompt: basePrompt,
        refRegistry,
        workspaceId: WORKSPACE_ID,
      }),
    ).toBe(basePrompt);

    const prompt = appendActiveFilePromptIfEntityExists({
      activeFile,
      entityExists: true,
      prompt: basePrompt,
      refRegistry,
      workspaceId: WORKSPACE_ID,
    });

    expect(prompt).toContain("Do NOT use it to edit");
    expect(prompt).not.toContain("ACTIVE DOCX EDITING");
    expect(prompt).not.toContain("apply-active-docx-edits");
  });

  test("instructs the model to use live DOCX edits when a snapshot is available", () => {
    const basePrompt = "Base prompt";
    const refRegistry = createChatRefRegistry();

    const prompt = appendActiveFilePromptIfEntityExists({
      activeFile: {
        docxEditSnapshot: {
          blocks: [
            {
              displayLabel: "7.1",
              id: "b-1",
              kind: "paragraph",
              styleId: "ClauseHeading1",
              text: "David Cuketa r.č.: DOPLNIT nar. 32.5.1990 bytem: xxx",
            },
          ],
        },
        entityId: toSafeId<"entity">("entity_docx"),
        fileName: "Kupni smlouva.docx",
        supportsDocxEdits: true,
      },
      entityExists: true,
      prompt: basePrompt,
      refRegistry,
      workspaceId: WORKSPACE_ID,
    });

    expect(prompt).toContain("apply-active-docx-edits");
    // Confirms-an-earlier-proposal trigger is part of the mandatory
    // tool-call clause; the example phrasing is language-agnostic
    // since the prompt was scrubbed of locale-specific examples.
    expect(prompt).toContain("confirms an earlier proposal");
    expect(prompt).toContain('"blockId":"b-1"');
    expect(prompt).toContain('"styleId":"ClauseHeading1"');
    expect(prompt).toContain("David Cuketa");
    expect(prompt).toContain(
      "only ids that appear in `applied` represent actual document changes",
    );
    expect(prompt).toContain("queued");
    // Internal component names must not leak into user-facing prompt.
    expect(prompt).not.toContain("Folio");
  });

  test("active-template prompt stays read-only until a snapshot exists", () => {
    const prompt = buildActiveTemplatePrompt(
      {
        templateId: toSafeId<"template">("tpl_test"),
        fileName: "Plna moc.docx",
      },
      FULL_TOOL_AVAILABILITY,
    );

    expect(prompt).toContain("ACTIVE TEMPLATE");
    expect(prompt).toContain("Plna moc.docx");
    expect(prompt).not.toContain("apply-active-docx-edits");
    expect(prompt).not.toContain("suggest_template_fields");
  });

  test("active-template prompt wires the suggest-fields and edit flows when a snapshot exists", () => {
    const prompt = buildActiveTemplatePrompt(
      {
        templateId: toSafeId<"template">("tpl_test"),
        fileName: "Plna moc.docx",
        docxEditSnapshot: {
          blocks: [
            {
              id: "b-1",
              kind: "paragraph",
              text: "Zmocnitel: Jan Novak, nar. 1.1.1990",
            },
          ],
        },
      },
      FULL_TOOL_AVAILABILITY,
    );

    expect(prompt).toContain("apply-active-docx-edits");
    expect(prompt).toContain("suggest_template_fields");
    expect(prompt).toContain('"blockId":"b-1"');
    expect(prompt).toContain("Jan Novak");
    // Only the text-replacement subset is honoured by the Studio.
    expect(prompt).toContain("`replaceInBlock`");
    expect(prompt).toContain("cannot honour `insertAfterBlock`");
    // Internal component names must not leak into user-facing prompt.
    expect(prompt).not.toContain("Folio");
  });

  test("active-template prompt drops the suggest-fields tool for roles without template authoring", () => {
    const prompt = buildActiveTemplatePrompt(
      {
        templateId: toSafeId<"template">("tpl_test"),
        fileName: "Plna moc.docx",
        docxEditSnapshot: {
          blocks: [
            {
              id: "b-1",
              kind: "paragraph",
              text: "Zmocnitel: Jan Novak, nar. 1.1.1990",
            },
          ],
        },
      },
      { templateAuthoring: false, webResearch: true },
    );

    // A `template: ["use"]`-only role (e.g. intern) never has
    // `suggest_template_fields` registered; the prompt must not steer
    // the model to it, but the field-marker workflow via
    // `apply-active-docx-edits` stays available.
    expect(prompt).not.toContain("suggest_template_fields");
    expect(prompt).toContain("FIELD SUGGESTIONS");
    expect(prompt).toContain("apply-active-docx-edits");
    expect(prompt).toContain("`{{fieldPath}}` marker verbatim");
  });
});

// Class guard: the assembled system prompt must never instruct the
// model to call a tool that is not registered for that configuration.
// We build the prompt across an availability matrix, extract every
// backtick-quoted tool-name-shaped token, and assert each is either a
// tool that IS registered for that config or an explicit non-tool
// code span. A future edit that names an unregistered tool (e.g.
// re-adds a `web_search` pointer to the web-off prompt) fails here.
describe("system prompt tool-reference guard", () => {
  // Tools always registered by getChatTools regardless of config, and
  // referenced by name in the prompt scaffold. `create-document` and
  // (given an active-template snapshot, which implies
  // hasActiveDocxEditClient) `apply-active-docx-edits` are always in
  // the map for the configurations swept here.
  const ALWAYS_REGISTERED_TOOL_NAMES = new Set([
    "ask-user",
    "execute_typescript",
    "discover_tools",
    "load-skill",
    "read-skill-resource",
    "create-document",
    "apply-active-docx-edits",
  ]);
  // Web research tools: registered only when `webResearch` is true.
  const WEB_RESEARCH_TOOL_NAMES = new Set([
    WEB_SEARCH_TOOL_NAME,
    FETCH_URL_TOOL_NAME,
  ]);
  const TEMPLATE_AUTHORING_TOOL_NAME = "suggest_template_fields";
  // Backtick spans that look like a tool name but are not one (schema
  // fields / plain nouns). Keep this list tight — everything not here
  // must resolve to a registered tool.
  const NON_TOOL_CODE_SPANS = new Set([
    "resources",
    "mention",
    // Active-template section: operation fields and result keys.
    "applied",
    "find",
    "replace",
    "instructions",
    "severity",
    "area",
    // Code-mode system prompt: JS keyword, not a tool.
    "await",
  ]);
  // A backtick span is "tool-name-shaped" when it is a bare lowercase
  // identifier with `-`/`_` separators: excludes `read.*` (dot),
  // `describe-stella-api({name})` (parens), `[1]` (brackets), and
  // anything with whitespace or uppercase.
  const TOOL_NAME_SHAPE = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/u;

  const extractToolNameTokens = (prompt: string): string[] => {
    const tokens: string[] = [];
    for (const match of prompt.matchAll(/`(?<span>[^`]+)`/gu)) {
      const span = match.groups?.["span"];
      if (span !== undefined && TOOL_NAME_SHAPE.test(span)) {
        tokens.push(span);
      }
    }
    return tokens;
  };

  // Mirrors how buildChatSystemPromptParts appends the active-template
  // section to the scaffold: core prompt + template appendix in one
  // assembled string, so the guard sees the same text the model does.
  const buildAssembledPrompts = (
    toolAvailability: ChatToolAvailability,
  ): string[] => {
    const refRegistry = createChatRefRegistry();
    const activeTemplateSection = buildActiveTemplatePrompt(
      {
        templateId: toSafeId<"template">("tpl_guard"),
        fileName: "Guard template.docx",
        docxEditSnapshot: {
          blocks: [{ id: "b-1", kind: "paragraph", text: "Guard block" }],
        },
      },
      toolAvailability,
    );
    return [
      buildGlobalPrompt({
        skillMetadata: SKILL_METADATA,
        toolAvailability,
        userContext: null,
      }),
      buildGlobalPrompt({
        skillMetadata: [],
        toolAvailability,
        userContext: null,
      }),
      `${buildWorkspacePromptText({
        entityCount: 3,
        refRegistry,
        skillMetadata: SKILL_METADATA,
        toolAvailability,
        userContext: null,
        workspaceId: WORKSPACE_ID,
        workspaceName: "Matter Alpha",
      })}\n\n${activeTemplateSection}`,
    ];
  };

  const AVAILABILITY_MATRIX: readonly ChatToolAvailability[] = [
    { templateAuthoring: true, webResearch: true },
    { templateAuthoring: true, webResearch: false },
    { templateAuthoring: false, webResearch: true },
    { templateAuthoring: false, webResearch: false },
  ];

  test("every tool named in the prompt is registered for that config", () => {
    for (const availability of AVAILABILITY_MATRIX) {
      const registered = new Set(ALWAYS_REGISTERED_TOOL_NAMES);
      if (availability.webResearch) {
        for (const name of WEB_RESEARCH_TOOL_NAMES) {
          registered.add(name);
        }
      }
      if (availability.templateAuthoring) {
        registered.add(TEMPLATE_AUTHORING_TOOL_NAME);
      }

      for (const prompt of buildAssembledPrompts(availability)) {
        for (const token of extractToolNameTokens(prompt)) {
          const allowed =
            registered.has(token) || NON_TOOL_CODE_SPANS.has(token);
          if (!allowed) {
            throw new Error(
              `Prompt names \`${token}\` but it is not registered for ` +
                `${JSON.stringify(availability)} and is not an ` +
                `allowlisted non-tool span`,
            );
          }
        }
      }
    }
  });

  test("web research tools are named iff they are registered", () => {
    for (const prompt of buildAssembledPrompts(FULL_TOOL_AVAILABILITY)) {
      expect(prompt).toContain(`\`${WEB_SEARCH_TOOL_NAME}\``);
      expect(prompt).toContain(`\`${FETCH_URL_TOOL_NAME}\``);
    }
    for (const prompt of buildAssembledPrompts({
      templateAuthoring: true,
      webResearch: false,
    })) {
      expect(prompt).not.toContain(WEB_SEARCH_TOOL_NAME);
      expect(prompt).not.toContain(FETCH_URL_TOOL_NAME);
      // The skill-grounding guidance and the run-stella-query warning
      // must survive when web research is off.
      expect(prompt).toContain("EXTERNAL-FACT SOURCING");
      expect(prompt).toContain("no external source was available");
    }
  });

  test("suggest_template_fields is named iff it is registered", () => {
    const withAuthoring = buildAssembledPrompts(FULL_TOOL_AVAILABILITY);
    expect(
      withAuthoring.some((prompt) =>
        prompt.includes(`\`${TEMPLATE_AUTHORING_TOOL_NAME}\``),
      ),
    ).toBe(true);
    for (const prompt of buildAssembledPrompts({
      templateAuthoring: false,
      webResearch: true,
    })) {
      expect(prompt).not.toContain(TEMPLATE_AUTHORING_TOOL_NAME);
    }
  });
});

describe("extractTitle", () => {
  test("falls back for empty titles and truncates long text", () => {
    const emptyParts = [
      { type: "text", content: "   " },
    ] satisfies ChatMessage["parts"];
    const longParts = [
      {
        type: "text",
        content: "A".repeat(81),
      },
    ] satisfies ChatMessage["parts"];

    expect(extractTitle(emptyParts)).toBe("New chat");
    expect(extractTitle(longParts)).toBe(`${"A".repeat(80)}…`);
  });

  test("ignores non-text parts when building the title", () => {
    const parts = [
      createChatAttachmentPart({
        filename: "attachment.pdf",
        mimeType: "application/pdf",
        url: "https://example.com/attachment.pdf",
      }),
      {
        type: "text",
        content: "Useful title",
      },
    ] satisfies ChatMessage["parts"];

    expect(extractTitle(parts)).toBe("Useful title");
  });

  test("strips html markup before returning the title", () => {
    const parts = [
      {
        type: "text",
        content: "<p>hello <strong>world</strong></p>",
      },
    ] satisfies ChatMessage["parts"];

    expect(extractTitle(parts)).toBe("hello world");
  });
});
