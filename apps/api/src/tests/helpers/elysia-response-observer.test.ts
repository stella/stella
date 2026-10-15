import { panic } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import { rejectionOf } from "@stll/property-testing/rejection";

import { installElysiaResponseObserver } from "./elysia-response-observer";

let uninstall: (() => void) | undefined;

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

describe("Elysia response observation", () => {
  test("observes handle without explicit compilation and preserves readable bodies", async () => {
    const paths: string[] = [];
    uninstall = installElysiaResponseObserver(async ({ request, response }) => {
      paths.push(new URL(request.url).pathname);
      expect(await response.json()).toEqual({ ok: true });
    });
    const app = new Elysia().get("/value", () => ({ ok: true }));
    const response = await app.handle(new Request("http://localhost/value"));
    expect(paths).toEqual(["/value"]);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("unused observer clones cancel without waiting for the caller's streaming branch", async () => {
    let sourceCancelled = false;
    const chunk = new TextEncoder().encode("stream data");
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        sourceCancelled = true;
      },
    });
    uninstall = installElysiaResponseObserver(async () => undefined);
    const app = new Elysia().get("/stream", () => new Response(stream));
    const response = await app.handle(new Request("http://localhost/stream"));
    if (response.body === null) {
      panic("Streaming fixture lost its body");
    }
    const reader = response.body.getReader();
    expect((await reader.read()).value).toEqual(chunk);
    await reader.cancel();
    expect(sourceCancelled).toBe(true);
  });

  test("observes explicit compilation once across repeated requests", async () => {
    let calls = 0;
    uninstall = installElysiaResponseObserver(async () => {
      calls += 1;
    });
    const app = new Elysia().get("/value", () => "ok").compile();
    await app.handle(new Request("http://localhost/value"));
    await app.handle(new Request("http://localhost/value"));
    expect(calls).toBe(2);
  });

  test("observes direct fetch calls", async () => {
    let calls = 0;
    uninstall = installElysiaResponseObserver(async () => {
      calls += 1;
    });
    const app = new Elysia().get("/value", () => "ok");
    expect(
      await (await app.fetch(new Request("http://localhost/value"))).text(),
    ).toBe("ok");
    expect(calls).toBe(1);
  });

  test.each([false, true])(
    "observes dynamic handle with explicit compilation %s",
    async (compile) => {
      let calls = 0;
      uninstall = installElysiaResponseObserver(async ({ response }) => {
        calls += 1;
        expect(await response.text()).toBe("dynamic");
      });
      const app = new Elysia({ aot: false }).get("/value", () => "dynamic");
      if (compile) {
        app.compile();
      }
      const response = await app.handle(new Request("http://localhost/value"));
      expect(await response.text()).toBe("dynamic");
      expect(calls).toBe(1);
    },
  );

  test.each([true, false])(
    "observer failures escape Elysia error conversion with aot %s",
    async (aot) => {
      let converted = false;
      uninstall = installElysiaResponseObserver(async () => {
        throw new Error("response contract failed");
      });
      const app = new Elysia({ aot })
        .onError(() => {
          converted = true;
          return "converted";
        })
        .get("/value", () => "ok");
      expect(
        String(
          await rejectionOf(app.handle(new Request("http://localhost/value"))),
        ),
      ).toContain("response contract failed");
      expect(converted).toBe(false);
    },
  );

  test("nested observers run newest first and restore only after the last subscription", async () => {
    const order: string[] = [];
    const originalFetch = Object.getOwnPropertyDescriptor(
      Elysia.prototype,
      "fetch",
    )?.get;
    const originalCompile = Elysia.prototype.compile;
    uninstall = installElysiaResponseObserver(async ({ response }) => {
      order.push(`outer:${await response.text()}`);
    });
    const patchedFetch = Object.getOwnPropertyDescriptor(
      Elysia.prototype,
      "fetch",
    )?.get;
    const patchedCompile = Elysia.prototype.compile;
    const stopInner = installElysiaResponseObserver(async ({ response }) => {
      order.push(`inner:${await response.text()}`);
    });
    try {
      await new Elysia()
        .get("/value", () => "both")
        .handle(new Request("http://localhost/value"));
      expect(order).toEqual(["inner:both", "outer:both"]);
      stopInner();
      stopInner();
      expect(
        Object.getOwnPropertyDescriptor(Elysia.prototype, "fetch")?.get,
      ).toBe(patchedFetch);
      expect(Elysia.prototype.compile).toBe(patchedCompile);
      await new Elysia()
        .get("/value", () => "outer")
        .handle(new Request("http://localhost/value"));
      expect(order).toEqual(["inner:both", "outer:both", "outer:outer"]);
      uninstall();
      uninstall = undefined;
      expect(
        Object.getOwnPropertyDescriptor(Elysia.prototype, "fetch")?.get,
      ).toBe(originalFetch);
      expect(Elysia.prototype.compile).toBe(originalCompile);
    } finally {
      stopInner();
    }
  });

  test("uninstall leaves future instances unobserved", async () => {
    let calls = 0;
    uninstall = installElysiaResponseObserver(async () => {
      calls += 1;
    });
    await new Elysia()
      .get("/value", () => "before")
      .handle(new Request("http://localhost/value"));
    uninstall();
    uninstall = undefined;
    const response = await new Elysia()
      .get("/value", () => "after")
      .handle(new Request("http://localhost/value"));
    expect(await response.text()).toBe("after");
    expect(calls).toBe(1);
  });
});
