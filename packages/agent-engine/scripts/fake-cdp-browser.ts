import { appendFileSync, createReadStream, createWriteStream } from "node:fs";

/**
 * A stand-in for Chrome behind `--remote-debugging-pipe`, for the stella
 * browser host's lifecycle tests: it reads NUL-framed protocol messages on
 * fd 3 and answers on fd 4, as Chrome does, with one page per target and
 * every frame asking for a sign-in. It records each message it receives
 * in `fake-cdp.log` in the profile folder it was started with. A navigation to an address containing `crash` makes
 * it exit, as a crashed browser does; `Browser.close` makes it exit too.
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
const sessions = new Map<string, string>();

const answer = (
  method: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
): object | "exit" => {
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
      setTimeout(() => {
        send({
          method: "Page.loadEventFired",
          params: { timestamp: 1 },
          sessionId,
        });
      }, 10);
      return { frameId: sessions.get(sessionId ?? "") ?? "", loaderId: "L1" };
    }
    case "Page.getFrameTree":
      return {
        frameTree: {
          frame: {
            id: sessions.get(sessionId ?? "") ?? "",
            loaderId: "L1",
            url: "https://research.example.com/",
          },
        },
      };
    case "Page.createIsolatedWorld":
      return { executionContextId: 1 };
    case "Runtime.callFunctionOn":
      return { result: { type: "object", value: { refused: "sign-in" } } };
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
    send({
      id,
      result,
      ...(typeof sessionId === "string" ? { sessionId } : {}),
    });
  }
});
input.on("end", () => {
  process.exit(0);
});
