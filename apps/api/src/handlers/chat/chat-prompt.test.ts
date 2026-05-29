import { describe, expect, test } from "bun:test";

import { createChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import { toSafeId } from "@/api/lib/branded-types";
import { DOCX_REVIEW_MARKUP_EXAMPLES } from "@/api/lib/docx-review-markup";

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
import type { ChatMessage } from "./types";

const WORKSPACE_ID = toSafeId<"workspace">("ws_prompt_test");
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

  test("system prompts include a compact stella API catalog", () => {
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
      expect(prompt).toContain("For stella data reads, use the stella API");
      expect(prompt).toContain("describe-stella-api");
      expect(prompt).toContain("run-stella-query");
      expect(prompt).toContain("result.items");
      expect(prompt).toContain("Available stella read functions");
      expect(prompt).toContain("read.listContacts({");
      expect(prompt).toContain("read.getMatterEntityContents({");
      expect(prompt).toContain("DOCX REVIEW TAGS");
      expect(prompt).toContain(DOCX_REVIEW_MARKUP_EXAMPLES.insertion);
      expect(prompt).toContain(DOCX_REVIEW_MARKUP_EXAMPLES.deletion);
      expect(prompt).toContain(DOCX_REVIEW_MARKUP_EXAMPLES.comment);
      // Full declarations and JSON schemas stay out of the prompt;
      // `describe-stella-api({name})` remains the detailed fallback.
      expect(prompt).not.toContain("namespace read {");
      expect(prompt).not.toContain("declare global {");
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
    expect(prompt).toContain("Current date/time:");
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
    expect(first.cacheStablePrefix).not.toContain("Current date/time");
    expect(first.fullPrompt).not.toBe(second.fullPrompt);
    expect(buildChatPromptCacheKey(first.cacheStablePrefix)).toBe(
      buildChatPromptCacheKey(second.cacheStablePrefix),
    );
  });

  test("routes installed skill metadata through the untrusted suffix", () => {
    const prompt = buildGlobalPromptParts({
      skillMetadata: [
        {
          description: "Use the Acme acquisition playbook.",
          name: "acme-acquisition-review",
          source: "installed",
          version: null,
        },
      ],
      userContext: null,
    });

    expect(prompt.cacheStablePrefix).not.toContain("acme-acquisition-review");
    expect(prompt.safePrompt).not.toContain("Acme acquisition");
    expect(prompt.untrustedSuffix).toContain("acme-acquisition-review");
    expect(prompt.untrustedSuffix).toContain("Acme acquisition");
    expect(prompt.fullPrompt).toContain("acme-acquisition-review");
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
