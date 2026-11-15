import { appendFileSync, createReadStream, createWriteStream } from "node:fs";

/**
 * A stand-in for Chrome behind `--remote-debugging-pipe`, for the stella
 * browser host's lifecycle tests: it reads NUL-framed protocol messages on
 * fd 3 and answers on fd 4, as Chrome does, with one page per target and
 * every frame asking for a sign-in. It records each message it receives
 * in `fake-cdp.log` in the profile folder it was started with. A
 * navigation to an address containing `crash` makes it exit, as a crashed
 * browser does; one containing `hang` ends its pipe while it keeps running
 * and ignores SIGTERM; one containing `unreachable` fails to load; one
 * containing `slow` loads after a second; one containing `framed-private`
 * holds a frame from a private address; `Browser.close` makes it exit.
 */

const PROFILE_FLAG = "--user-data-dir=";
const profile = process.argv
  .find((arg) => arg.startsWith(PROFILE_FLAG))
  ?.slice(PROFILE_FLAG.length);
const log = profile === undefined ? undefined : `${profile}/fake-cdp.log`;
const input = createReadStream("", { fd: 3 });
const output = createWriteStream("", { fd: 4 });

const send = (message: object) => {
  output.write(`${JSON.stringify(message)}\0`);
};

let targets = 0;
/** Set once it hangs: it no longer ends with its pipe either. */
const state = { hanging: false };
const sessions = new Map<string, string>();
/** The address each page session last navigated to. */
const addresses = new Map<string, string>();

/**
 * What the page script answers in a page: a page whose address holds
 * `moves-away` asks for no sign-in but has moved to another origin by the
 * time it is read; one holding `moves-away-quietly` has moved too but
 * reads anyway, ignoring the origin it was told to hold to; every other
 * page asks for a sign-in.
 */
const pageAnswer = (address: string, operation: unknown): object => {
  if (address.includes("moves-away-quietly")) {
    return {
      origin: "https://elsewhere.example.com",
      pageControls: [],
      pageControlsLeftOut: false,
      title: "Elsewhere",
      url: "https://elsewhere.example.com/",
      window: {
        controls: [],
        controlsLeftOut: false,
        end: { type: "end" },
        fromPercent: 0,
        hasAfter: false,
        hasBefore: false,
        links: [],
        linksLeftOut: false,
        start: { type: "start" },
        text: "Elsewhere",
        toPercent: 100,
      },
    };
  }
  // A page with a private frame asks for no sign-in either, so the check
  // for one reaches every frame.
  if (!address.includes("moves-away") && !address.includes("framed-private")) {
    return { refused: "sign-in" };
  }
  const expected =
    typeof operation === "object" && operation !== null
      ? Reflect.get(operation, "expectedTopOrigin")
      : undefined;
  return expected === undefined
    ? { refused: "none" }
    : { refused: "top-origin" };
};

const answer = (
  method: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
): object | "exit" | "hang" => {
  switch (method) {
    case "Browser.getVersion":
      return { product: "Chrome/150.0.0.0", protocolVersion: "1.3" };
    case "Browser.close":
      return "exit";
    case "Target.createTarget": {
      targets += 1;
      return { targetId: `T${String(targets)}` };
    }
    case "Target.attachToTarget": {
      const sessionIdOf = `S${String(params["targetId"])}`;
      sessions.set(sessionIdOf, String(params["targetId"]));
      return { sessionId: sessionIdOf };
    }
    case "Page.navigate": {
      // A crash: gone without an answer.
      if (String(params["url"]).includes("crash")) {
        process.exit(1);
      }
      // A hung browser: its pipe ends, it stays, and it ignores SIGTERM.
      if (String(params["url"]).includes("hang")) {
        state.hanging = true;
        process.on("SIGTERM", () => undefined);
        output.end();
        setInterval(() => undefined, 60_000);
        return "hang";
      }
      addresses.set(sessionId ?? "", String(params["url"]));
      // A page with a frame in another process: it attaches on the page's session.
      if (String(params["url"]).includes("framed")) {
        send({
          method: "Target.attachedToTarget",
          params: {
            sessionId: "FRAME-SESSION",
            targetInfo: {
              targetId: "FRAME-1",
              type: "iframe",
              url: "https://frames.example.com/",
            },
            waitingForDebugger: false,
          },
          sessionId,
        });
      }
      const frameId = sessions.get(sessionId ?? "") ?? "";
      if (String(params["url"]).includes("unreachable")) {
        return { errorText: "net::ERR_NAME_NOT_RESOLVED", frameId };
      }
      setTimeout(
        () => {
          send({
            method: "Page.loadEventFired",
            params: { timestamp: 1 },
            sessionId,
          });
        },
        String(params["url"]).includes("slow") ? 1000 : 10,
      );
      return { frameId, loaderId: "L1" };
    }
    case "Page.getFrameTree": {
      const address = addresses.get(sessionId ?? "") ?? "about:blank";
      const top = {
        id: sessions.get(sessionId ?? "") ?? "",
        loaderId: "L1",
        securityOrigin: URL.parse(address)?.origin ?? "null",
        url: address,
      };
      // A frame from a private address, in the page's own process.
      return address.includes("framed-private")
        ? {
            frameTree: {
              childFrames: [
                {
                  frame: {
                    id: "PRIVATE-FRAME",
                    loaderId: "L2",
                    parentId: top.id,
                    securityOrigin: "https://10.0.0.5",
                    url: "https://10.0.0.5/",
                  },
                },
              ],
              frame: top,
            },
          }
        : { frameTree: { frame: top } };
    }
    case "Page.createIsolatedWorld":
      return { executionContextId: 1 };
    case "Runtime.callFunctionOn": {
      const args: unknown = params["arguments"];
      const first: unknown = Array.isArray(args) ? args[0] : undefined;
      const operation =
        typeof first === "object" && first !== null
          ? Reflect.get(first, "value")
          : undefined;
      return {
        result: {
          type: "object",
          value: pageAnswer(addresses.get(sessionId ?? "") ?? "", operation),
        },
      };
    }
    default:
      return {};
  }
};

let buffer = "";
input.on("data", (chunk: Buffer | string) => {
  buffer += chunk.toString();
  let end = buffer.indexOf("\0");
  while (end !== -1) {
    const message: unknown = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    end = buffer.indexOf("\0");
    if (log !== undefined) {
      appendFileSync(log, `${JSON.stringify(message)}\n`);
    }
    if (typeof message !== "object" || message === null) {
      continue;
    }
    const id: unknown = Reflect.get(message, "id");
    const method: unknown = Reflect.get(message, "method");
    const params: unknown = Reflect.get(message, "params");
    const sessionId: unknown = Reflect.get(message, "sessionId");
    const result = answer(
      String(method),
      typeof params === "object" && params !== null
        ? Object.fromEntries(Object.entries(params))
        : {},
      typeof sessionId === "string" ? sessionId : undefined,
    );
    if (result === "exit") {
      send({ id, result: {} });
      output.end(() => process.exit(0));
      return;
    }
    if (result === "hang") {
      return;
    }
    send({
      id,
      result,
      ...(typeof sessionId === "string" ? { sessionId } : {}),
    });
  }
});
input.on("end", () => {
  if (!state.hanging) {
    process.exit(0);
  }
});
