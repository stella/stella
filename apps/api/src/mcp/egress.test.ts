import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";
import type { McpEgressPlan } from "@/api/mcp/tool-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

const anonymizeTextFieldsMock = mock();
const loadAnonymizationGazetteerEntriesMock = mock();
const realAnonymizationBlacklist =
  await import("@/api/lib/anonymization-blacklist");

void mock.module("@/api/mcp/anonymization", () => ({
  anonymizeTextFields: anonymizeTextFieldsMock,
}));

void mock.module("@/api/lib/anonymization-blacklist", () => ({
  ...realAnonymizationBlacklist,
  loadAnonymizationGazetteerEntries: loadAnonymizationGazetteerEntriesMock,
}));

const { finalizeMcpEgress } = await import("@/api/mcp/egress");

const createContext = (): McpRequestContext => {
  const scopedDb = asTestRaw<McpRequestContext["scopedDb"]>(mock());
  return {
    accessibleWorkspaceIds: [toSafeId<"workspace">("ws_1")],
    accessibleWorkspaceIdSet: new Set(["ws_1"]),
    accessibleWorkspaceStatusById: new Map([["ws_1", "active"]]),
    accessibleWorkspaces: [],
    grantedScopes: [],
    memberRole: "owner",
    organizationId: toSafeId<"organization">("org_1"),
    recordAuditEvent: asTestRaw(mock(async () => undefined)),
    safeDb: toSafeDbMock(scopedDb),
    scopedDb,
    userId: toSafeId<"user">("user_1"),
  };
};

const parseText = (result: CallToolResult): unknown => {
  const item = result.content.at(0);
  if (!item || item.type !== "text") {
    throw new Error("Expected a text MCP response");
  }
  return JSON.parse(item.text);
};

const parsePayload = (result: CallToolResult) =>
  asTestRaw<{
    text: string;
    title: string;
    nextCursor: string | null;
    metadata: { anonymized?: boolean; charCount: number };
  }>(parseText(result));

describe("finalizeMcpEgress", () => {
  afterAll(() => {
    mock.restore();
  });

  beforeEach(() => {
    anonymizeTextFieldsMock.mockReset();
    loadAnonymizationGazetteerEntriesMock.mockReset();
    loadAnonymizationGazetteerEntriesMock.mockResolvedValue([]);
  });

  test("returns a finished CallToolResult untouched", async () => {
    const finished = {
      content: [{ type: "text" as const, text: "already done" }],
    };
    expect(
      await finalizeMcpEgress({
        context: createContext(),
        mode: "anonymized",
        response: finished,
      }),
    ).toBe(finished);
    expect(anonymizeTextFieldsMock).not.toHaveBeenCalled();
  });

  test("compatFetch windows the raw text in default mode without anonymizing", async () => {
    const rawText = `${"x".repeat(8000)}${"y".repeat(10)}`;
    const plan: McpEgressPlan = {
      egress: "compatFetch",
      cursor: undefined,
      id: "entity_1",
      maxChars: 8000,
      text: rawText,
      title: "John Smith SPA",
      url: "https://example.test/doc",
      workspaceId: "ws_1",
    };

    const payload = parsePayload(
      await finalizeMcpEgress({
        context: createContext(),
        mode: "default",
        response: plan,
      }),
    );

    expect(payload.title).toBe("John Smith SPA");
    expect(payload.text).toBe("x".repeat(8000));
    expect(payload.metadata.anonymized).toBeUndefined();
    expect(anonymizeTextFieldsMock).not.toHaveBeenCalled();
  });

  test("compatFetch anonymizes the whole document before windowing, keeping placeholders stable across windows", async () => {
    // The anonymized document is longer than a single window and repeats the
    // same entity's placeholder in two different windows. Anonymizing the whole
    // document once (not per window) is what keeps `[PERSON_1]` intact at each
    // window edge and numbered consistently across windows.
    const person = "[PERSON_1]";
    const anonText = `${person}0123456789${person}abcdefghijTAIL`;
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 1,
      fields: ["[PERSON_1] SPA", anonText],
    });

    const basePlan = {
      egress: "compatFetch" as const,
      id: "entity_1",
      maxChars: 20,
      // Raw text contains the real name; it must never appear in any window.
      text: "John Smith met John Smith at the office to sign the SPA.",
      title: "John Smith SPA",
      url: "https://example.test/doc",
      workspaceId: "ws_1",
    };

    const context = createContext();
    const window1 = parsePayload(
      await finalizeMcpEgress({
        context,
        mode: "anonymized",
        response: { ...basePlan, cursor: undefined },
      }),
    );

    // Anonymization ran exactly once, on the whole raw title + text.
    expect(anonymizeTextFieldsMock).toHaveBeenCalledTimes(1);
    expect(anonymizeTextFieldsMock.mock.calls.at(0)?.[0]).toMatchObject({
      fields: [basePlan.title, basePlan.text],
      workspaceId: "ws_1",
    });

    expect(window1.title).toBe("[PERSON_1] SPA");
    expect(window1.text).toBe("[PERSON_1]0123456789");
    expect(window1.text).toContain("[PERSON_1]");
    expect(window1.text).not.toContain("John Smith");
    expect(window1.metadata.anonymized).toBe(true);
    expect(window1.metadata.charCount).toBe(anonText.length);
    expect(window1.nextCursor).not.toBeNull();

    const window2 = parsePayload(
      await finalizeMcpEgress({
        context,
        mode: "anonymized",
        response: { ...basePlan, cursor: window1.nextCursor ?? undefined },
      }),
    );

    // Same entity, same placeholder, intact at the next window's edge.
    expect(window2.text).toBe("[PERSON_1]abcdefghij");
    expect(window2.text.startsWith("[PERSON_1]")).toBe(true);
    expect(window2.text).not.toContain("John Smith");

    const window3 = parsePayload(
      await finalizeMcpEgress({
        context,
        mode: "anonymized",
        response: { ...basePlan, cursor: window2.nextCursor ?? undefined },
      }),
    );
    expect(window3.text).toBe("TAIL");
    expect(window3.nextCursor).toBeNull();

    // The windows reconstruct exactly the anonymized document.
    expect(window1.text + window2.text + window3.text).toBe(anonText);
    // Anonymization still ran only three times total (once per call), never
    // re-anonymizing a slice.
    expect(anonymizeTextFieldsMock).toHaveBeenCalledTimes(3);
  });

  test("compatSearch strips workspaceId in default mode and anonymizes titles in anonymized mode", async () => {
    const results = [
      {
        id: "entity_1",
        title: "John Smith SPA",
        url: "https://example.test/1",
        workspaceId: "ws_1",
      },
    ];

    const defaultPayload = asTestRaw<{
      results: { workspaceId?: string; title: string }[];
    }>(
      parseText(
        await finalizeMcpEgress({
          context: createContext(),
          mode: "default",
          response: { egress: "compatSearch", nextCursor: null, results },
        }),
      ),
    );
    expect(defaultPayload.results[0]?.workspaceId).toBeUndefined();
    expect(defaultPayload.results[0]?.title).toBe("John Smith SPA");
    expect(anonymizeTextFieldsMock).not.toHaveBeenCalled();

    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 1,
      fields: ["[PERSON_1] SPA"],
    });
    const anonPayload = asTestRaw<{
      results: { workspaceId?: string; title: string }[];
    }>(
      parseText(
        await finalizeMcpEgress({
          context: createContext(),
          mode: "anonymized",
          response: { egress: "compatSearch", nextCursor: null, results },
        }),
      ),
    );
    expect(anonPayload.results[0]?.title).toBe("[PERSON_1] SPA");
    expect(anonPayload.results[0]?.workspaceId).toBeUndefined();
  });

  test("structured plan batches anonymization per workspace and applies it back", async () => {
    // Two matters in two workspaces. Each workspace anonymizes in its own
    // batch, so placeholders reset per tenant and cannot cross-reference.
    const matters = [
      { id: "ws_1", name: "John Smith Ltd" },
      { id: "ws_2", name: "Jane Doe GmbH" },
    ];
    anonymizeTextFieldsMock
      .mockResolvedValueOnce({ entityCount: 1, fields: ["[PERSON_1] Ltd"] })
      .mockResolvedValueOnce({ entityCount: 1, fields: ["[PERSON_1] GmbH"] });

    const payload = asTestRaw<{ matters: { id: string; name: string }[] }>(
      parseText(
        await finalizeMcpEgress({
          context: createContext(),
          mode: "anonymized",
          response: {
            egress: "structured",
            payload: { matters },
            textFields: matters.map((matter) => ({
              apply: (value: string) => {
                matter.name = value;
              },
              value: matter.name,
              workspaceId: matter.id,
            })),
          },
        }),
      ),
    );

    expect(payload.matters[0]?.name).toBe("[PERSON_1] Ltd");
    expect(payload.matters[1]?.name).toBe("[PERSON_1] GmbH");
    expect(anonymizeTextFieldsMock).toHaveBeenCalledTimes(2);
    expect(anonymizeTextFieldsMock.mock.calls.at(0)?.[0]).toMatchObject({
      fields: ["John Smith Ltd"],
      workspaceId: "ws_1",
    });
    expect(anonymizeTextFieldsMock.mock.calls.at(1)?.[0]).toMatchObject({
      fields: ["Jane Doe GmbH"],
      workspaceId: "ws_2",
    });
  });

  test("structured plan anonymizes the whole field before windowing it", async () => {
    // The window field is anonymized first, so the redacted placeholder is
    // intact at the window edge and the raw name never appears in any slice.
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 1,
      fields: ["[PERSON_1] doc", `[PERSON_1] signed here and there`],
    });
    const payload: {
      name: string;
      text: string;
      charCount: number;
      truncated: boolean;
      nextCursor: string | null;
    } = {
      name: "John Smith doc",
      text: "John Smith signed here and there",
      charCount: 0,
      truncated: false,
      nextCursor: null,
    };

    const result = asTestRaw<typeof payload>(
      parseText(
        await finalizeMcpEgress({
          context: createContext(),
          mode: "anonymized",
          response: {
            egress: "structured",
            payload,
            textFields: [
              {
                apply: (value: string) => {
                  payload.name = value;
                },
                value: payload.name,
                workspaceId: "ws_1",
              },
              {
                apply: (value: string) => {
                  payload.text = value;
                },
                value: payload.text,
                workspaceId: "ws_1",
              },
            ],
            window: {
              cursor: undefined,
              maxChars: 10,
              read: () => payload.text,
              apply: (textWindow) => {
                payload.text = textWindow.text;
                payload.charCount = textWindow.charCount;
                payload.truncated = textWindow.truncated;
                payload.nextCursor = textWindow.nextCursor;
              },
            },
          },
        }),
      ),
    );

    // First 10 chars of the ANONYMIZED text, not the raw text.
    expect(result.text).toBe("[PERSON_1]");
    expect(result.text).not.toContain("John Smith");
    expect(result.charCount).toBe("[PERSON_1] signed here and there".length);
    expect(result.truncated).toBe(true);
    expect(result.nextCursor).not.toBeNull();
    expect(result.name).toBe("[PERSON_1] doc");
  });

  test("structured plan windows raw text and skips anonymization in default mode", async () => {
    const payload: {
      text: string;
      charCount: number;
      truncated: boolean;
      nextCursor: string | null;
    } = {
      text: "John Smith signed here",
      charCount: 0,
      truncated: false,
      nextCursor: null,
    };

    const result = asTestRaw<typeof payload>(
      parseText(
        await finalizeMcpEgress({
          context: createContext(),
          mode: "default",
          response: {
            egress: "structured",
            payload,
            textFields: [
              {
                apply: (value: string) => {
                  payload.text = value;
                },
                value: payload.text,
                workspaceId: "ws_1",
              },
            ],
            window: {
              cursor: undefined,
              maxChars: 10,
              read: () => payload.text,
              apply: (textWindow) => {
                payload.text = textWindow.text;
                payload.charCount = textWindow.charCount;
                payload.truncated = textWindow.truncated;
                payload.nextCursor = textWindow.nextCursor;
              },
            },
          },
        }),
      ),
    );

    expect(result.text).toBe("John Smith");
    expect(result.charCount).toBe("John Smith signed here".length);
    expect(anonymizeTextFieldsMock).not.toHaveBeenCalled();
  });
});
