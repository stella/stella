import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";
import { propertyConfig } from "@stll/property-testing";

import { toSafeId } from "@/api/lib/branded-types";
import { normalizeChatMessageHtml } from "@/api/lib/markdown/chat-message";

describe("chat message markdown serializer", () => {
  test("serializes workspace mentions to stella markdown links", () => {
    const html =
      '<p>Open <entity-mention data-id="ws_123" data-label="Alpha Matter" data-category="workspace"></entity-mention>.</p>';

    expect(normalizeChatMessageHtml(html, ["ws_123"]).text).toBe(
      "Open [Alpha Matter](#stella-workspace=ws_123).",
    );
  });

  test("serializes entity mentions with their source workspace ID in the href", () => {
    const html =
      '<p>Check <entity-mention data-id="ent_123" data-label="Retention Memo" data-category="entity" data-source-workspace-id="ws_123"></entity-mention>.</p>';

    expect(normalizeChatMessageHtml(html, ["ws_123"]).text).toBe(
      "Check [Retention Memo](#stella-entity=ws_123:ent_123).",
    );
  });

  test("serializes case-law decision references without structured mention metadata", () => {
    const html =
      '<p>Viz <entity-mention data-id="decision)final" data-label="28 Cdo 5171/2008" data-category="decision"></entity-mention>.</p>';

    expect(normalizeChatMessageHtml(html, [])).toEqual({
      mentions: [],
      text: "Viz [28 Cdo 5171/2008](#stella-decision=decision%29final).",
    });
  });

  test("extracts structured mentions while keeping model-facing entity links clean", () => {
    const html =
      '<p>Check <entity-mention data-id="ent_123" data-label="Retention Memo" data-category="entity" data-source-workspace-id="ws_123"></entity-mention>.</p>';

    expect(normalizeChatMessageHtml(html, ["ws_123"])).toEqual({
      mentions: [
        {
          category: "entity",
          id: "ent_123",
          label: "Retention Memo",
          resource: resourceRef({
            type: RESOURCE_TYPE.ENTITY,
            id: toSafeId<"entity">("ent_123"),
          }),
          workspaceId: "ws_123",
        },
      ],
      text: "Check [Retention Memo](#stella-entity=ws_123:ent_123).",
    });
  });

  test("strips unsafe markup while preserving safe links", () => {
    const html =
      '<p>Hello<script>alert(1)</script><a href="javascript:alert(1)">bad</a><a href="https://example.com">good</a></p>';

    const markdown = normalizeChatMessageHtml(html, []).text;

    expect(markdown).not.toContain("script");
    // oxlint-disable-next-line no-script-url -- asserting the unsafe scheme was stripped
    expect(markdown).not.toContain("javascript:");
    expect(markdown).toContain("[good](https://example.com)");
  });

  test("preserves skill reference links for explicit skill loading", () => {
    const html =
      '<p>Use <a href="#stella-skill-ref=due-diligence">Due Diligence</a>.</p>';

    expect(normalizeChatMessageHtml(html, []).text).toBe(
      "Use [Due Diligence](#stella-skill-ref=due-diligence).",
    );
  });

  test("drops inaccessible workspace mentions from markdown and metadata", () => {
    const html =
      '<p>In <entity-mention data-id="ws_bad" data-label="Secret" data-category="workspace"></entity-mention> and <entity-mention data-id="ws_ok" data-label="OK WS" data-category="workspace"></entity-mention>.</p>';

    const { mentions, text } = normalizeChatMessageHtml(html, ["ws_ok"]);

    expect(mentions).toEqual([
      {
        category: "workspace",
        id: "ws_ok",
        label: "OK WS",
        resource: resourceRef({
          type: RESOURCE_TYPE.WORKSPACE,
          id: toSafeId<"workspace">("ws_ok"),
        }),
      },
    ]);
    expect(text).toBe("In and [OK WS](#stella-workspace=ws_ok).");
  });

  test("drops entity mentions when source workspace is inaccessible", () => {
    const html =
      '<p><entity-mention data-id="ent_1" data-label="Doc A" data-category="entity" data-source-workspace-id="ws_bad"></entity-mention> and <entity-mention data-id="ent_2" data-label="Doc B" data-category="entity" data-source-workspace-id="ws_ok"></entity-mention>.</p>';

    const { mentions, text } = normalizeChatMessageHtml(html, ["ws_ok"]);

    expect(mentions).toEqual([
      {
        category: "entity",
        id: "ent_2",
        label: "Doc B",
        resource: resourceRef({
          type: RESOURCE_TYPE.ENTITY,
          id: toSafeId<"entity">("ent_2"),
        }),
        workspaceId: "ws_ok",
      },
    ]);
    expect(text).toBe("and [Doc B](#stella-entity=ws_ok:ent_2).");
  });

  test("keeps distinct opaque mention identity tuples", () => {
    const segment = fc.stringMatching(/^[a-z0-9]{1,12}$/u);

    fc.assert(
      fc.property(segment, segment, segment, (a, b, c) => {
        const firstWorkspaceId = a;
        const secondWorkspaceId = `${a}:${b}`;
        const firstEntityId = `${b}:${c}`;
        const secondEntityId = c;
        const html =
          `<p><entity-mention data-id="${firstEntityId}" data-label="Entity 1" data-category="entity" data-source-workspace-id="${firstWorkspaceId}"></entity-mention>` +
          ` and <entity-mention data-id="${secondEntityId}" data-label="Entity 2" data-category="entity" data-source-workspace-id="${secondWorkspaceId}"></entity-mention>.</p>`;

        const { mentions } = normalizeChatMessageHtml(html, [
          firstWorkspaceId,
          secondWorkspaceId,
        ]);

        const identities = mentions.map((mention) => {
          switch (mention.category) {
            case "entity":
              return [mention.workspaceId, mention.id];
            case "workspace":
              return [null, mention.id];
            default:
              return mention satisfies never;
          }
        });

        expect(identities).toEqual([
          [firstWorkspaceId, firstEntityId],
          [secondWorkspaceId, secondEntityId],
        ]);
      }),
      propertyConfig({ numRuns: 100 }),
    );
  });
});
