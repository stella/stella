import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  readStellaMcpAppCall,
  SHOW_APP_LIMITS,
  SHOW_APP_TOOL_NAME,
  STELLA_MCP_APP_MIME_TYPE,
  stellaMcpAppPartSchema,
} from "@stll/api-contract/stella-mcp-app";
import { CASE_LAW_RESULTS_RESOURCE_URI } from "@stll/mcp-apps/resource-uri";

import { classifyChatPartForPersistence } from "@/api/handlers/chat/chat-message-parts";
import { createVisualResourceOrigin } from "@/api/handlers/visual-sandbox/resource-origin";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { createShowAppTool, createTurnAppLedger } from "./show-app-tool";

const searchRead = {
  toolName: "search_case_law",
  call: {
    input: { query: "unfair dismissal" },
    result: { structuredContent: { results: [{ id: "decision-one" }] } },
  },
};

type Emitted = { name: string; value: unknown };

const runTool = async ({
  tool,
  appId,
  toolCallId = "show-call-one",
}: {
  tool: ReturnType<typeof createShowAppTool>;
  appId: unknown;
  toolCallId?: string;
}) => {
  const emitted: Emitted[] = [];
  const execute =
    tool[SHOW_APP_TOOL_NAME].execute ?? panic("The app tool has no executor");
  const outcome = await Result.tryPromise({
    try: async () =>
      await Promise.resolve(
        execute(
          // A model can send anything; the tool's own parse decides.
          asTestRaw<{ app_id: string }>({ app_id: appId }),
          {
            toolCallId,
            emitCustomEvent: (name: string, value: unknown) => {
              emitted.push({ name, value });
            },
          },
        ),
      ),
    catch: (cause) => cause,
  });
  return { outcome, emitted };
};

describe("the turn's ledger of reads an app can show", () => {
  test("names each read a chat app presents, and no other", () => {
    const ledger = createTurnAppLedger();
    expect(ledger.record(searchRead)).toBe("app_1");
    expect(
      ledger.record({ ...searchRead, toolName: "read_provision_history" }),
    ).toBe("app_2");
    for (const toolName of [
      "list_matters",
      "read_document",
      "list_case_law_courts",
    ]) {
      expect(ledger.record({ ...searchRead, toolName })).toBeUndefined();
    }
  });

  test("holds a bounded number of reads per turn", () => {
    const ledger = createTurnAppLedger();
    for (let index = 0; index < SHOW_APP_LIMITS.appsPerTurn; index += 1) {
      expect(ledger.record(searchRead)).toBe(`app_${String(index + 1)}`);
    }
    expect(ledger.record(searchRead)).toBeUndefined();
  });

  test("gives a read out once, and never one of another turn", () => {
    const thisTurn = createTurnAppLedger();
    const otherTurn = createTurnAppLedger();
    const appId = thisTurn.record(searchRead) ?? panic("Read not kept");
    expect(Result.isError(otherTurn.take(appId))).toBe(true);
    expect(thisTurn.take(appId).unwrap()).toEqual(searchRead);
    expect(Result.isError(thisTurn.take(appId))).toBe(true);
    expect(Result.isError(thisTurn.take("app_9"))).toBe(true);
  });
});

describe("show_app", () => {
  test("mints the app for a read of this turn under the tool's own call", async () => {
    const ledger = createTurnAppLedger();
    const origin = createVisualResourceOrigin();
    const appId = ledger.record(searchRead) ?? panic("Read not kept");
    const { outcome, emitted } = await runTool({
      tool: createShowAppTool({ ledger, origin }),
      appId,
    });
    expect(outcome.unwrap()).toEqual({ shown: true, tool: "search_case_law" });
    expect(emitted.map(({ name }) => name)).toEqual(["ui-resource"]);
    const part = v.parse(stellaMcpAppPartSchema, emitted.at(0)?.value);
    expect(part).toMatchObject({
      resource: {
        uri: CASE_LAW_RESULTS_RESOURCE_URI,
        mimeType: STELLA_MCP_APP_MIME_TYPE,
      },
      toolCallId: "show-call-one",
      toolName: "search_case_law",
    });
    expect(readStellaMcpAppCall(part)).toEqual(searchRead.call);
    // The turn's origin accepts what it minted; another origin does not.
    expect(
      classifyChatPartForPersistence(structuredClone(part), origin).type,
    ).toBe("persist");
    expect(
      classifyChatPartForPersistence(
        structuredClone(part),
        createVisualResourceOrigin(),
      ).type,
    ).toBe("drop");
  });

  test("refuses an unknown, repeated or malformed app id and shows nothing", async () => {
    const ledger = createTurnAppLedger();
    const tool = createShowAppTool({
      ledger,
      origin: createVisualResourceOrigin(),
    });
    const appId = ledger.record(searchRead) ?? panic("Read not kept");
    await runTool({ tool, appId });
    for (const candidate of [appId, "app_7", "decision-one", 1, ""]) {
      const { outcome, emitted } = await runTool({ tool, appId: candidate });
      expect(Result.isError(outcome)).toBe(true);
      if (Result.isError(outcome)) {
        expect(outcome.error).toBeInstanceOf(ChatToolError);
      }
      expect(emitted).toEqual([]);
    }
  });
});
