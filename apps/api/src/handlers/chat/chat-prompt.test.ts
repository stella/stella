import { describe, expect, test } from "bun:test";

import type { PropertyContent } from "@/api/db/schema-validators";
import { createChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import { toSafeId } from "@/api/lib/branded-types";

import {
  appendActiveFilePromptIfEntityExists,
  buildChatPromptCacheKey,
  buildGlobalPrompt,
  buildGlobalPromptParts,
  buildUserContextBlock,
  buildWorkspacePromptParts,
  buildWorkspacePromptText,
  extractTitle,
} from "./chat-prompt";
import type { WorkspacePromptProperty } from "./chat-prompt";
import type { ChatMessage } from "./types";

const WORKSPACE_ID = toSafeId<"workspace">("ws_prompt_test");
const READONLY_STELLA_API = `declare global {
  namespace stella {
    listMatters(input: {limit?: number; offset?: number}): Promise<{items: {matterRef: string}[]; nextOffset: number | null; hasMore: boolean}>;
    getMatterEntityContents(input: {matterRefs: string[]; entityRefs: string[]}): Promise<{text: string}[]>;
  }
}`;
const SKILL_METADATA = [
  {
    name: "legal-interpretation",
    description: "Analyze legal texts using an interpretation framework.",
    version: "3.0",
  },
] as const;

const createProperty = ({
  content,
  id,
  name,
  status = "fresh",
}: {
  content: PropertyContent;
  id: string;
  name: string;
  status?: WorkspacePromptProperty["status"];
}): WorkspacePromptProperty => ({
  content,
  id,
  name,
  status,
});

describe("chat prompt builders", () => {
  test("renders option labels only for initialized select properties", () => {
    const refRegistry = createChatRefRegistry();
    const prompt = buildWorkspacePromptText({
      entityCount: 42,
      properties: [
        createProperty({
          content: {
            fallback: null,
            options: [
              { color: "red", value: "Open" },
              { color: "green", value: "Closed" },
            ],
            type: "single-select",
            version: 1,
          },
          id: "prop_stage",
          name: "Stage",
        }),
        createProperty({
          content: {
            fallback: null,
            options: [
              { color: "amber", value: "Urgent" },
              { color: "blue", value: "Client" },
            ],
            type: "multi-select",
            version: 1,
          },
          id: "prop_labels",
          name: "Labels",
        }),
        createProperty({
          content: {
            fallback: null,
            options: [{ color: "orange", value: "Draft" }],
            type: "single-select",
            version: 1,
          },
          id: "prop_hidden",
          name: "Hidden",
          status: "stale",
        }),
      ],
      refRegistry,
      readonlyStellaApi: READONLY_STELLA_API,
      userContext: null,
      workspaceId: WORKSPACE_ID,
      workspaceName: "Matter Alpha",
    });

    expect(prompt).toContain(
      "- Stage (ref: prop_1, type: single-select) [options: Open, Closed]",
    );
    expect(prompt).toContain(
      "- Labels (ref: prop_2, type: multi-select) [options: Urgent, Client]",
    );
    expect(prompt).not.toContain("prop_hidden");
  });

  test("does not render option labels for non-select property types", () => {
    const refRegistry = createChatRefRegistry();
    const prompt = buildWorkspacePromptText({
      entityCount: 0,
      properties: [
        createProperty({
          content: {
            type: "text",
            version: 1,
          },
          id: "prop_notes",
          name: "Notes",
        }),
      ],
      refRegistry,
      readonlyStellaApi: READONLY_STELLA_API,
      userContext: null,
      workspaceId: WORKSPACE_ID,
      workspaceName: "Matter Alpha",
    });

    expect(prompt).toContain("- Notes (ref: prop_1, type: text)");
    expect(prompt).not.toContain("type: text) [options:");
  });

  test("includes the readonly stella API block in the workspace prompt", () => {
    const refRegistry = createChatRefRegistry();
    const prompt = buildWorkspacePromptText({
      entityCount: 1,
      properties: [],
      refRegistry,
      readonlyStellaApi: READONLY_STELLA_API,
      userContext: null,
      workspaceId: WORKSPACE_ID,
      workspaceName: "Matter Alpha",
    });

    expect(prompt).toContain("Readonly `stella` API:");
    expect(prompt).toContain("declare global {");
    expect(prompt).toContain("namespace stella {");
    expect(prompt).toContain("getMatterEntityContents(input:");
    expect(prompt).toContain(
      "Use `describe-stella-function` only as a fallback",
    );
    expect(prompt).not.toContain("call `stella-capabilities` once");
    expect(prompt).toContain("Use `execute-typescript` for readonly retrieval");
    expect(prompt).toContain("`stella.get*` functions require explicit refs");
    expect(prompt).toContain("[Document Name](#stella-entity-ref=ent_1)");
    expect(prompt).toContain("Do not write forms like");
  });

  test("includes the readonly stella API block in the global prompt", () => {
    const prompt = buildGlobalPrompt({
      readonlyStellaApi: READONLY_STELLA_API,
      skillMetadata: SKILL_METADATA,
      userContext: null,
    });

    expect(prompt).toContain("Available Stella skills");
    expect(prompt).toContain("legal-interpretation");
    expect(prompt).toContain("Use `execute-typescript` for readonly retrieval");
    expect(prompt).toContain("require explicit `matterRefs` inputs");
    expect(prompt).toContain("caps it at 500");
    expect(prompt).toContain(
      "Use `describe-stella-function` only as a fallback",
    );
    expect(prompt).toContain("namespace stella {");
  });

  test("does not include UI locale in the prompt", () => {
    const prompt = buildUserContextBlock({
      locale: "cs",
      timezone: "Europe/Prague",
      userName: "Jan Kubica",
    });

    expect(prompt).toContain("User registered as: Jan Kubica");
    expect(prompt).toContain("Current date/time:");
    expect(prompt).not.toContain("UX language:");
    expect(prompt).not.toContain("cs");
  });

  test("keeps the cache-stable prefix independent from volatile user context", () => {
    const first = buildGlobalPromptParts({
      readonlyStellaApi: READONLY_STELLA_API,
      skillMetadata: SKILL_METADATA,
      userContext: {
        locale: "en",
        timezone: "Europe/Prague",
        userName: "First User",
      },
    });
    const second = buildGlobalPromptParts({
      readonlyStellaApi: READONLY_STELLA_API,
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
    expect(first.cacheStablePrefix).not.toContain("Current date/time");
    expect(first.fullPrompt).not.toBe(second.fullPrompt);
    expect(buildChatPromptCacheKey(first.cacheStablePrefix)).toBe(
      buildChatPromptCacheKey(second.cacheStablePrefix),
    );
  });

  test("keeps the cache-stable prefix independent from workspace context", () => {
    const firstRefRegistry = createChatRefRegistry();
    const secondRefRegistry = createChatRefRegistry();
    const first = buildWorkspacePromptParts({
      entityCount: 1,
      properties: [],
      refRegistry: firstRefRegistry,
      readonlyStellaApi: READONLY_STELLA_API,
      skillMetadata: SKILL_METADATA,
      userContext: null,
      workspaceId: WORKSPACE_ID,
      workspaceName: "Matter Alpha",
    });
    const second = buildWorkspacePromptParts({
      entityCount: 500,
      properties: [
        createProperty({
          content: {
            type: "text",
            version: 1,
          },
          id: "prop_notes",
          name: "Notes",
        }),
      ],
      refRegistry: secondRefRegistry,
      readonlyStellaApi: READONLY_STELLA_API,
      skillMetadata: SKILL_METADATA,
      userContext: null,
      workspaceId: toSafeId<"workspace">("ws_prompt_other"),
      workspaceName: "Matter Beta",
    });

    expect(first.cacheStablePrefix).toBe(second.cacheStablePrefix);
    expect(first.cacheStablePrefix).not.toContain("Matter Alpha");
    expect(first.cacheStablePrefix).not.toContain("prop_notes");
    expect(first.fullPrompt).toContain("Matter Alpha");
    expect(second.fullPrompt).toContain("Matter Beta");
    expect(buildChatPromptCacheKey(first.cacheStablePrefix)).toBe(
      buildChatPromptCacheKey(second.cacheStablePrefix),
    );
  });

  test("changes the cache key when stable prompt content changes", () => {
    const first = buildGlobalPromptParts({
      readonlyStellaApi: READONLY_STELLA_API,
      skillMetadata: SKILL_METADATA,
      userContext: null,
    });
    const second = buildGlobalPromptParts({
      readonlyStellaApi: `${READONLY_STELLA_API}\n// added function`,
      skillMetadata: SKILL_METADATA,
      userContext: null,
    });

    expect(buildChatPromptCacheKey(first.cacheStablePrefix)).not.toBe(
      buildChatPromptCacheKey(second.cacheStablePrefix),
    );
  });

  test("omits empty skill catalog sections cleanly", () => {
    const prompt = buildGlobalPromptParts({
      readonlyStellaApi: READONLY_STELLA_API,
      skillMetadata: [],
      userContext: null,
    });

    expect(prompt.cacheStablePrefix).not.toContain("Available Stella skills");
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

    expect(
      appendActiveFilePromptIfEntityExists({
        activeFile,
        entityExists: true,
        prompt: basePrompt,
        refRegistry,
        workspaceId: WORKSPACE_ID,
      }),
    ).toContain("stella.getMatterEntities");
  });
});

describe("extractTitle", () => {
  test("falls back for empty titles and truncates long text", () => {
    const emptyParts = [
      { text: "   ", type: "text" },
    ] satisfies ChatMessage["parts"];
    const longParts = [
      {
        text: "A".repeat(81),
        type: "text",
      },
    ] satisfies ChatMessage["parts"];

    expect(extractTitle(emptyParts)).toBe("New chat");
    expect(extractTitle(longParts)).toBe(`${"A".repeat(80)}…`);
  });

  test("ignores non-text parts when building the title", () => {
    const parts = [
      {
        filename: "attachment.pdf",
        mediaType: "application/pdf",
        type: "file",
        url: "https://example.com/attachment.pdf",
      },
      {
        text: "Useful title",
        type: "text",
      },
    ] satisfies ChatMessage["parts"];

    expect(extractTitle(parts)).toBe("Useful title");
  });

  test("strips html markup before returning the title", () => {
    const parts = [
      {
        text: "<p>hello <strong>world</strong></p>",
        type: "text",
      },
    ] satisfies ChatMessage["parts"];

    expect(extractTitle(parts)).toBe("hello world");
  });
});
