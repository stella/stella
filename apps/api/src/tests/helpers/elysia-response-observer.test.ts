import { afterEach, describe, expect, spyOn, test } from "bun:test";
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
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
    });
    const app = new Elysia().get("/value", () => ({ ok: true }));
    const response = await app.handle(new Request("http://localhost/value"));
    expect(paths).toEqual(["/value"]);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("borrows a streaming response without cloning or consuming its body", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first\n"));
        controller.enqueue(new TextEncoder().encode("last\n"));
        controller.close();
      },
    });
    const original = new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    });
    const clone = spyOn(original, "clone");
    try {
      uninstall = installElysiaResponseObserver(async ({ response }) => {
        expect(response).toBe(original);
        expect(response.headers.get("content-type")).toBe("text/event-stream");
      });
      const app = new Elysia().get("/stream", () => original);
      const response = await app.handle(new Request("http://localhost/stream"));
      expect(clone).not.toHaveBeenCalled();
      expect(await response.text()).toBe("first\nlast\n");
    } finally {
      clone.mockRestore();
    }
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
        expect(response.status).toBe(200);
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
      order.push(`outer:${response.headers.get("x-value")}`);
    });
    const patchedFetch = Object.getOwnPropertyDescriptor(
      Elysia.prototype,
      "fetch",
    )?.get;
    const patchedCompile = Elysia.prototype.compile;
    const stopInner = installElysiaResponseObserver(async ({ response }) => {
      order.push(`inner:${response.headers.get("x-value")}`);
    });
    try {
      await new Elysia()
        .get(
          "/value",
          () => new Response("both", { headers: { "x-value": "both" } }),
        )
        .handle(new Request("http://localhost/value"));
      expect(order).toEqual(["inner:both", "outer:both"]);
      stopInner();
      stopInner();
      expect(
        Object.getOwnPropertyDescriptor(Elysia.prototype, "fetch")?.get,
      ).toBe(patchedFetch);
      expect(Elysia.prototype.compile).toBe(patchedCompile);
      await new Elysia()
        .get(
          "/value",
          () => new Response("outer", { headers: { "x-value": "outer" } }),
        )
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
