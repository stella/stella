import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  CDP_METHOD_ALLOWLIST,
  type CdpMethod,
  createCdpClient,
} from "./cdp-client";

const sentSchema = v.object({
  id: v.number(),
  method: v.string(),
  params: v.unknown(),
  sessionId: v.optional(v.string()),
});

/** A client whose sent messages the test reads and answers. */
const connected = () => {
  const sent: v.InferOutput<typeof sentSchema>[] = [];
  const methods: CdpMethod[] = [];
  const client = createCdpClient(
    {
      send: (json) => {
        sent.push(v.parse(sentSchema, JSON.parse(json)));
        return true;
      },
    },
    {
      onSend: (method) => {
        methods.push(method);
      },
    },
  );
  const answer = (id: number, result: unknown, sessionId?: string) => {
    client.receive(
      JSON.stringify({
        id,
        result,
        ...(sessionId === undefined ? {} : { sessionId }),
      }),
    );
  };
  return { answer, client, methods, sent };
};

describe("the stella browser's protocol client", () => {
  test("can send exactly these methods: no network, storage, debugger or main-world script", () => {
    expect(CDP_METHOD_ALLOWLIST.toSorted()).toEqual([
      "Browser.close",
      "Browser.getVersion",
      "Browser.setDownloadBehavior",
      "Page.createIsolatedWorld",
      "Page.enable",
      "Page.getFrameTree",
      "Page.navigate",
      "Runtime.callFunctionOn",
      "Target.attachToTarget",
      "Target.closeTarget",
      "Target.createTarget",
      "Target.setAutoAttach",
      "Target.setDiscoverTargets",
    ]);
  });

  test("refuses a method outside the list without writing anything, even through a cast", async () => {
    const { client, methods, sent } = connected();
    const send: (
      method: string,
      params: object,
    ) => ReturnType<typeof client.send> = (method, params) =>
      Reflect.apply(client.send, undefined, [method, params]);
    for (const method of [
      "Runtime.enable",
      "Runtime.evaluate",
      "Network.getCookies",
      "Storage.getCookies",
      "Page.addScriptToEvaluateOnNewDocument",
      "Target.exposeDevToolsProtocol",
    ]) {
      const refused = await send(method, {});
      expect(Result.isError(refused) ? refused.error : null).toEqual({
        type: "refused",
      });
    }
    expect(sent).toEqual([]);
    expect(methods).toEqual([]);
  });

  test("matches each answer to its call by id, in any order, with its session", async () => {
    const { answer, client, sent } = connected();
    const version = client.send("Browser.getVersion", {});
    const tree = client.send("Page.getFrameTree", {}, { sessionId: "S1" });
    expect(
      sent.map(({ id, method, sessionId }) => ({ id, method, sessionId })),
    ).toEqual([
      { id: 1, method: "Browser.getVersion", sessionId: undefined },
      { id: 2, method: "Page.getFrameTree", sessionId: "S1" },
    ]);
    answer(
      2,
      {
        frameTree: {
          frame: { id: "F", loaderId: "L", url: "https://a.example.com/" },
        },
      },
      "S1",
    );
    answer(1, { product: "Chrome/150.0.1.2", protocolVersion: "1.3" });
    const [versionResult, treeResult] = await Promise.all([version, tree]);
    expect(
      Result.isOk(versionResult) ? versionResult.value.product : null,
    ).toBe("Chrome/150.0.1.2");
    expect(
      Result.isOk(treeResult) ? treeResult.value.frameTree.frame.id : null,
    ).toBe("F");
  });

  test("an answer of another shape, a protocol error, a timeout and a stop each fail their call", async () => {
    const { answer, client } = connected();
    const shapeless = client.send("Target.createTarget", {
      background: true,
      newWindow: true,
      url: "about:blank",
    });
    answer(1, { notTheTarget: true });
    expect(await shapeless).toEqual(Result.err({ type: "invalid" }));

    const refused = client.send("Page.navigate", {
      url: "https://a.example.com/",
    });
    client.receive(JSON.stringify({ error: { message: "No target" }, id: 2 }));
    expect(await refused).toEqual(
      Result.err({ message: "No target", type: "protocol" }),
    );

    expect(await client.send("Page.enable", {}, { timeoutMs: 5 })).toEqual(
      Result.err({ type: "timeout" }),
    );

    const stop = new AbortController();
    const stopped = client.send("Page.enable", {}, { signal: stop.signal });
    stop.abort();
    expect(await stopped).toEqual(Result.err({ type: "aborted" }));
  });

  test("hands events to their listeners with the session they came on, and fails every call once disconnected", async () => {
    const { client } = connected();
    const loads: (string | null)[] = [];
    const stopListening = client.on(
      "Page.loadEventFired",
      (_params, sessionId) => {
        loads.push(sessionId);
      },
    );
    client.receive(
      JSON.stringify({
        method: "Page.loadEventFired",
        params: { timestamp: 1 },
        sessionId: "S1",
      }),
    );
    stopListening();
    client.receive(
      JSON.stringify({
        method: "Page.loadEventFired",
        params: { timestamp: 2 },
        sessionId: "S2",
      }),
    );
    expect(loads).toEqual(["S1"]);

    const pending = client.send("Browser.getVersion", {});
    client.disconnect();
    expect(await pending).toEqual(Result.err({ type: "disconnected" }));
    expect(await client.send("Browser.getVersion", {})).toEqual(
      Result.err({ type: "disconnected" }),
    );
  });
});
