import { describe, expect, test } from "bun:test";

import { startLoopbackListener } from "./loopback-listener.js";

describe("startLoopbackListener", () => {
  test("binds an ephemeral 127.0.0.1 port and reports it in redirectUri", async () => {
    const listener = await startLoopbackListener();
    try {
      expect(listener).toBeDefined();
      expect(listener?.port).toBeGreaterThan(0);
      expect(listener?.redirectUri).toBe(
        `http://127.0.0.1:${listener?.port}/callback`,
      );
    } finally {
      listener?.close();
    }
  });

  test("delivers a success callback parsed from the redirect query string", async () => {
    const listener = await startLoopbackListener();
    if (!listener) {
      throw new Error("listener failed to bind");
    }

    try {
      const pending = listener.waitForCallback(5000);
      const response = await fetch(
        `${listener.redirectUri}?code=abc123&state=xyz789`,
      );
      expect(response.status).toBe(200);

      const callback = await pending;
      expect(callback).toEqual({
        code: "abc123",
        kind: "success",
        state: "xyz789",
      });
    } finally {
      listener.close();
    }
  });

  test("delivers an error callback with error_description when the provider redirects an error", async () => {
    const listener = await startLoopbackListener();
    if (!listener) {
      throw new Error("listener failed to bind");
    }

    try {
      const pending = listener.waitForCallback(5000);
      const url = new URL(listener.redirectUri);
      url.searchParams.set("error", "access_denied");
      url.searchParams.set("error_description", "user declined consent");
      url.searchParams.set("state", "xyz789");
      await fetch(url);

      const callback = await pending;
      expect(callback).toEqual({
        error: "access_denied",
        errorDescription: "user declined consent",
        kind: "error",
        state: "xyz789",
      });
    } finally {
      listener.close();
    }
  });

  test("responds 400 and does not resolve when code or state is missing", async () => {
    const listener = await startLoopbackListener();
    if (!listener) {
      throw new Error("listener failed to bind");
    }

    try {
      const response = await fetch(`${listener.redirectUri}?code=abc123`);
      expect(response.status).toBe(400);
    } finally {
      listener.close();
    }
  });

  test("responds 404 for a path other than the callback path", async () => {
    const listener = await startLoopbackListener();
    if (!listener) {
      throw new Error("listener failed to bind");
    }

    try {
      const response = await fetch(`http://127.0.0.1:${listener.port}/other`);
      expect(response.status).toBe(404);
    } finally {
      listener.close();
    }
  });

  test("waitForCallback times out with a LoopbackTimeoutError when nothing arrives", async () => {
    const listener = await startLoopbackListener();
    if (!listener) {
      throw new Error("listener failed to bind");
    }

    try {
      const result = await listener.waitForCallback(20);
      if (!(result instanceof Error)) {
        throw new Error("expected a LoopbackTimeoutError");
      }
      expect(result.name).toBe("LoopbackTimeoutError");
    } finally {
      listener.close();
    }
  });
});
