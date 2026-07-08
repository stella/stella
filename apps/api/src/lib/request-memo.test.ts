import { describe, expect, test } from "bun:test";

import { memoizePerRequest } from "@/api/lib/request-memo";

describe("memoizePerRequest", () => {
  test("computes once and reuses the result across repeated calls for the same request", async () => {
    const cache = new WeakMap<Request, Promise<number>>();
    const request = new Request("http://localhost/");
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return calls;
    };

    const first = await memoizePerRequest(cache, request, compute);
    const second = await memoizePerRequest(cache, request, compute);
    const third = await memoizePerRequest(cache, request, compute);

    expect(calls).toBe(1);
    expect(first).toBe(1);
    expect(second).toBe(1);
    expect(third).toBe(1);
  });

  test("coalesces concurrent calls for the same request into one computation", async () => {
    const cache = new WeakMap<Request, Promise<number>>();
    const request = new Request("http://localhost/");
    let calls = 0;
    const compute = async () => {
      calls += 1;
      await Promise.resolve();
      return calls;
    };

    const [first, second] = await Promise.all([
      memoizePerRequest(cache, request, compute),
      memoizePerRequest(cache, request, compute),
    ]);

    expect(calls).toBe(1);
    expect(first).toBe(1);
    expect(second).toBe(1);
  });

  test("computes independently for different request objects (no cross-request caching)", async () => {
    const cache = new WeakMap<Request, Promise<number>>();
    const requestA = new Request("http://localhost/a");
    const requestB = new Request("http://localhost/b");
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return calls;
    };

    const resultA = await memoizePerRequest(cache, requestA, compute);
    const resultB = await memoizePerRequest(cache, requestB, compute);

    expect(calls).toBe(2);
    expect(resultA).toBe(1);
    expect(resultB).toBe(2);
  });

  test("computes independently across separate cache instances for the same request", async () => {
    // Guards the security-relevant boundary: a caller that (incorrectly)
    // used a fresh cache per invocation would silently lose memoization
    // rather than accidentally widen it, but this pins the expected
    // per-cache isolation so that assumption stays visible.
    const request = new Request("http://localhost/");
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return calls;
    };

    const resultA = await memoizePerRequest(
      new WeakMap<Request, Promise<number>>(),
      request,
      compute,
    );
    const resultB = await memoizePerRequest(
      new WeakMap<Request, Promise<number>>(),
      request,
      compute,
    );

    expect(calls).toBe(2);
    expect(resultA).toBe(1);
    expect(resultB).toBe(2);
  });
});
