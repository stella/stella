import { Panic, UnhandledException } from "better-result";
import { SQL } from "bun";
import { describe, expect, test } from "bun:test";

import { classifyFailure } from "@stll/errors";

import { DatabaseRlsError, HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  MAX_EVIDENCE_DEPTH,
  readEvidence,
  readProviderStatus,
} from "@/api/lib/observability/failure-evidence";

const at = (location: string): string => `    at run (${location})`;

const errorWithStack = (message: string, stack: string): Error => {
  const error = new Error(message);
  error.stack = stack;
  return error;
};

const chainOf = (length: number): Error => {
  let error = new Error("level 0");
  for (let level = 1; level < length; level++) {
    error = new Error(`level ${level}`, { cause: error });
  }
  return error;
};

describe("failure evidence walks the chain once", () => {
  test("records every level outermost first, over plain objects too", () => {
    const body = { code: "insufficient_quota", status: 429 };
    const evidence = readEvidence(
      new UnhandledException({
        cause: new HandlerError({
          status: 502,
          message: "wrapped",
          cause: body,
        }),
      }),
    );

    expect(evidence.nodes.map((node) => [node.kind, node.tag])).toEqual([
      ["tagged", "UnhandledException"],
      ["tagged", "HandlerError"],
      ["plain", "UnknownError"],
    ]);
    expect(evidence.truncation).toBe("none");
    expect(evidence.nodes[2]?.providerStatus).toEqual({
      status: 429,
      source: "status",
    });
  });

  test("stops at the depth limit and says so", () => {
    const evidence = readEvidence(chainOf(10));

    expect(evidence.nodes).toHaveLength(MAX_EVIDENCE_DEPTH);
    expect(evidence.truncation).toBe("depth");
  });

  test("a chain that ends exactly at the limit is not truncated", () => {
    const evidence = readEvidence(chainOf(MAX_EVIDENCE_DEPTH));

    expect(evidence.nodes).toHaveLength(MAX_EVIDENCE_DEPTH);
    expect(evidence.truncation).toBe("none");
  });

  test("stops at a cycle and records where it points back to", () => {
    const outer = new Error("outer");
    const inner = new Error("inner", { cause: outer });
    outer.cause = inner;
    const selfCaused = new Error("self");
    selfCaused.cause = selfCaused;

    expect(readEvidence(outer)).toMatchObject({
      truncation: "cycle",
      cycleTo: 0,
    });
    expect(readEvidence(outer).nodes).toHaveLength(2);
    expect(readEvidence(selfCaused).nodes).toHaveLength(1);
    expect(readEvidence(selfCaused).cycleTo).toBe(0);
  });

  test("a thrown string, null or nothing is one primitive node", () => {
    for (const thrown of ["boom", null, undefined, 42]) {
      expect(readEvidence(thrown)).toEqual({
        nodes: [
          expect.objectContaining({ kind: "primitive", tag: "UnknownError" }),
        ],
        truncation: "none",
        cycleTo: undefined,
      });
    }
  });

  test("a primitive cause still names that the wrapper had one", () => {
    const evidence = readEvidence(new Error("x", { cause: "reason" }));

    expect(evidence.nodes.map((node) => node.kind)).toEqual([
      "error",
      "primitive",
    ]);
  });

  test("memoizes per error object", () => {
    const error = new Error("x");

    expect(readEvidence(error)).toBe(readEvidence(error));
    expect(readEvidence(new Error("x"))).not.toBe(readEvidence(error));
  });
});

describe("failure evidence survives hostile values", () => {
  test("a revoked Proxy reads as a failed read, not a throw", () => {
    const { proxy, revoke } = Proxy.revocable(new Error("x"), {});
    revoke();

    const evidence = readEvidence(proxy);

    expect(evidence.truncation).toBe("read_failed");
    expect(evidence.nodes).toHaveLength(1);
  });

  test("a Proxy whose every trap throws reads as a failed read", () => {
    const hostile = new Proxy(new Error("x"), {
      get: () => {
        throw new TypeError("get");
      },
      getPrototypeOf: () => {
        throw new TypeError("getPrototypeOf");
      },
      has: () => {
        throw new TypeError("has");
      },
    });

    expect(readEvidence(hostile).truncation).toBe("read_failed");
  });

  test("a throwing getter fails its own read only", () => {
    const error = Object.defineProperty(new Error("x"), "code", {
      get: () => {
        throw new TypeError("no code");
      },
    });
    Object.assign(error, { syscall: "read", errno: -54 });

    const [node] = readEvidence(error).nodes;

    expect(readEvidence(error).truncation).toBe("read_failed");
    expect(node).toMatchObject({
      code: undefined,
      syscall: "read",
      errno: -54,
    });
  });

  test("a getter that changes on every read is read once", () => {
    let reads = 0;
    const codes = ["ECONNRESET", "PRIVILEGED-SENTINEL"];
    const error = Object.defineProperty(new Error("x"), "code", {
      get: () => {
        const code = codes[reads % codes.length];
        reads += 1;
        return code;
      },
    });

    const evidence = readEvidence(error);

    expect(reads).toBe(1);
    expect(evidence.nodes[0]?.code).toBe("ECONNRESET");
  });

  test("a Proxy with an endless prototype chain is bounded", () => {
    const endless: object = new Proxy(
      {},
      {
        getPrototypeOf: () => endless,
      },
    );

    expect(readEvidence(endless).nodes[0]?.prototypes.length).toBeLessThan(32);
  });
});

describe("failure evidence reads identity", () => {
  test("a declared class name is kept only when the constructor vouches for it", () => {
    // Classes whose identifiers a build rewrote: named through
    // `defineProperty`, exactly as a bundler's output reports them.
    const errorClassNamed = (identifier: string, declared: string) => {
      const ErrorClass = class extends Error {
        constructor(message: string) {
          super(message);
          this.name = declared;
        }
      };
      Object.defineProperty(ErrorClass, "name", { value: identifier });
      return ErrorClass;
    };
    const Suffixed = errorClassNamed("DrizzleQueryError2", "DrizzleQueryError");
    const Minified = errorClassNamed("e", "Panic");
    const anonymous = new (class extends Error {})("x");

    expect(readEvidence(new Suffixed("x")).nodes[0]?.className).toBe(
      "DrizzleQueryError",
    );
    // A writable `name` the identifier does not prove is not trusted.
    expect(readEvidence(new Minified("x")).nodes[0]?.className).toBe("e");
    expect(readEvidence(anonymous).nodes[0]?.className).toBe("Error");
  });

  test("a DOMException name is read only from the allowlist", () => {
    const timeout = new DOMException("timed out", "TimeoutError");
    const other = new DOMException("x", "PRIVILEGED-SENTINEL");

    expect(readEvidence(timeout).nodes[0]?.domName).toBe("TimeoutError");
    expect(readEvidence(other).nodes[0]?.domName).toBeUndefined();
  });

  test("a fake _tag on a plain object is not a tag", () => {
    const [node] = readEvidence({ _tag: "PRIVILEGED-SENTINEL" }).nodes;

    expect(node).toMatchObject({ kind: "plain", tag: "UnknownError" });
  });

  test("pg provenance comes from the driver, not from a code's shape", () => {
    const driver = new SQL.PostgresError("terminating connection", {
      code: "ERR_POSTGRES_SERVER_ERROR",
      errno: "57P01",
      detail: "",
      hint: "",
      severity: "FATAL",
    });
    const shaped = { code: "57P01" };

    expect(readEvidence(driver).nodes[0]).toMatchObject({
      sqlState: "57P01",
      pgProvenance: true,
    });
    expect(readEvidence(shaped).nodes[0]).toMatchObject({
      sqlState: "57P01",
      pgProvenance: false,
    });
  });

  test("a class brand and an instance brand are both read", () => {
    const rls = new DatabaseRlsError({ message: "denied" });
    const branded = classifyFailure(new Error("x"), "upstream_unavailable");

    expect(readEvidence(rls).nodes[0]?.brand?.reason).toBe("rls_denied");
    expect(readEvidence(branded).nodes[0]?.brand).toEqual({
      reason: "upstream_unavailable",
      source: "instance",
    });
  });
});

describe("failure evidence reads frames", () => {
  test("takes the first frame after the message's own lines", () => {
    const error = errorWithStack(
      "first line\n    at fake (/app/apps/api/src/forged.ts:9:9)",
      [
        "Error: first line",
        "    at fake (/app/apps/api/src/forged.ts:9:9)",
        at("/app/apps/api/src/real.ts:1:2"),
      ].join("\n"),
    );

    expect(readEvidence(error).nodes[0]?.frame).toEqual({
      kind: "recognized",
      location: "/app/apps/api/src/real.ts:1:2",
    });
  });

  test("a message-less error still yields its frame", () => {
    const error = errorWithStack(
      "",
      ["Error", at("apps/api/src/empty.ts:3:4")].join("\n"),
    );

    expect(readEvidence(error).nodes[0]?.frame).toEqual({
      kind: "recognized",
      location: "apps/api/src/empty.ts:3:4",
    });
  });

  test("a frame outside this build's paths is present but not shipped", () => {
    const error = errorWithStack(
      "x",
      ["Error: x", "    at <anonymous> (PRIVILEGED-SENTINEL.js:1:16)"].join(
        "\n",
      ),
    );

    expect(readEvidence(error).nodes[0]?.frame).toEqual({
      kind: "unrecognized",
    });
  });

  test("non-V8 frames and a stack whose header is not the message yield none", () => {
    const firefox = errorWithStack("x", "run@/app/apps/api/src/a.ts:1:2");
    const mismatched = errorWithStack(
      "x",
      ["Error: something else", at("/app/apps/api/src/a.ts:1:2")].join("\n"),
    );
    const empty = new DOMException("t", "TimeoutError");

    expect(readEvidence(firefox).nodes[0]?.frame).toEqual({ kind: "absent" });
    expect(readEvidence(mismatched).nodes[0]?.frame).toEqual({
      kind: "absent",
    });
    expect(readEvidence(empty).nodes[0]?.frame).toEqual({ kind: "absent" });
  });

  test("a 1 MB message costs a bounded read", () => {
    const message = "x".repeat(1024 * 1024);
    const error = errorWithStack(
      message,
      [`Error: ${message}`, at("/app/apps/api/src/big.ts:5:6")].join("\n"),
    );
    const started = performance.now();

    const frame = readEvidence(error).nodes[0]?.frame;

    expect(frame).toEqual({
      kind: "recognized",
      location: "/app/apps/api/src/big.ts:5:6",
    });
    expect(performance.now() - started).toBeLessThan(250);
  });

  test("frames past the line bound are not searched", () => {
    const filler = Array.from({ length: 200 }, () => "    at <native>").join(
      "\n",
    );
    const error = errorWithStack(
      "x",
      ["Error: x", filler, at("/app/apps/api/src/late.ts:1:2")].join("\n"),
    );

    expect(readEvidence(error).nodes[0]?.frame).toEqual({ kind: "absent" });
  });

  test("a line cut at the frame byte bound is not read as a shorter location", () => {
    const frame = at("/app/apps/api/src/late.ts:12:34");
    // Pad so the 8 KiB window ends between the column's two digits: read
    // whole, the cut line would parse as column 3.
    const cutAfter = frame.length - "4)".length;
    const padding = 8 * 1024 - cutAfter - 1;
    const filler = `    at ${"a".repeat(padding - "    at ".length)}`;
    const error = errorWithStack("x", ["Error: x", filler, frame].join("\n"));
    const control = errorWithStack(
      "x",
      ["Error: x", "    at short", frame].join("\n"),
    );

    expect(readEvidence(control).nodes[0]?.frame).toEqual({
      kind: "recognized",
      location: "/app/apps/api/src/late.ts:12:34",
    });
    expect(readEvidence(error).nodes[0]?.frame).toEqual({ kind: "absent" });
  });
});

describe("provider status provenance", () => {
  test("names where the status came from", () => {
    const cases = [
      [{ statusCode: 503 }, { status: 503, source: "statusCode" }],
      [{ status: 429 }, { status: 429, source: "status" }],
      [
        { $metadata: { httpStatusCode: 500 } },
        { status: 500, source: "metadata" },
      ],
      [{ code: "402" }, { status: 402, source: "code" }],
      [{ error: { status: 404 } }, { status: 404, source: "body_status" }],
      [{ error: { code: "401" } }, { status: 401, source: "body_code" }],
    ] as const;

    for (const [value, expected] of cases) {
      expect(readProviderStatus(value)).toEqual(expected);
    }
  });

  test("a HandlerError's own status is not a provider status", () => {
    const wrapped = new HandlerError({
      status: 502,
      code: "429",
      message: "x",
    });

    expect(readProviderStatus(wrapped)).toEqual({
      status: 429,
      source: "code",
    });
    expect(
      readProviderStatus(new HandlerError({ status: 502, message: "x" })),
    ).toBeUndefined();
  });

  test("an integer outside the HTTP range, or a symbolic code, is no status", () => {
    expect(readProviderStatus({ status: 99 })).toBeUndefined();
    expect(readProviderStatus({ statusCode: 600 })).toBeUndefined();
    expect(readProviderStatus({ code: "insufficient_quota" })).toBeUndefined();
    expect(readProviderStatus(new Panic({ message: "x" }))).toBeUndefined();
  });
});
