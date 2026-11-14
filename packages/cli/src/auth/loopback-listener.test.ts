import { describe, expect, test } from "bun:test";

import { sha256Base64Url } from "../sha256.js";
import { startLoopbackListener } from "./loopback-listener.js";

describe("startLoopbackListener", () => {
  test("binds an ephemeral 127.0.0.1 port and reports it in redirectUri", async () => {
    const listener = await startLoopbackListener({ expectedState: "xyz789" });
    if (!listener) {
      throw new Error("listener failed to bind");
    }

    try {
      expect(listener.port).toBeGreaterThan(0);
      expect(listener.redirectUri).toBe(
        `http://127.0.0.1:${listener.port}/callback`,
      );
    } finally {
      listener.close();
    }
  });

  test("delivers a success callback parsed from the redirect query string", async () => {
    const listener = await startLoopbackListener({ expectedState: "xyz789" });
    if (!listener) {
      throw new Error("listener failed to bind");
    }

    try {
      const pending = listener.waitForCallback(5000);
      const response = fetch(
        `${listener.redirectUri}?code=abc123&state=xyz789`,
      );

      const callback = await pending;
      expect(callback).toEqual({
        code: "abc123",
        kind: "success",
        state: "xyz789",
      });
      await listener.finish({ kind: "signed_in" });
      expect((await response).status).toBe(200);
    } finally {
      listener.close();
    }
  });

  test("delivers an error callback with error_description when the provider redirects an error", async () => {
    const listener = await startLoopbackListener({ expectedState: "xyz789" });
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
    const listener = await startLoopbackListener({ expectedState: "xyz789" });
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
    const listener = await startLoopbackListener({ expectedState: "xyz789" });
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
    const listener = await startLoopbackListener({ expectedState: "xyz789" });
    if (!listener) {
      throw new Error("listener failed to bind");
    }

    try {
      const result = await listener.waitForCallback(20);
      if (!(result instanceof Error)) {
        throw new TypeError("expected a LoopbackTimeoutError");
      }
      expect(result.name).toBe("LoopbackTimeoutError");
    } finally {
      listener.close();
    }
  });
});

const textContent = async (html: string, selector: string) => {
  let content = "";
  await new HTMLRewriter()
    .on(selector, {
      text: (chunk) => {
        content += chunk.text;
      },
    })
    .transform(new Response(html))
    .text();
  return content;
};

describe("browser sign-in completion", () => {
  test("shows one branded success screen with the organization escaped as text", async () => {
    const listener = await startLoopbackListener({
      expectedState: "expected-state",
    });
    expect(listener).toBeDefined();
    if (!listener) {
      return;
    }
    try {
      const organizationName = `Novák & Partners <script>alert("x")</script> 'Legal'`;
      const url = new URL(listener.redirectUri);
      url.searchParams.set("code", "authorization-code");
      url.searchParams.set("state", "expected-state");
      url.searchParams.set("organization_name", organizationName);
      const answered = fetch(url, { signal: AbortSignal.timeout(1000) });
      expect(await listener.waitForCallback(1000)).toEqual({
        kind: "success",
        code: "authorization-code",
        state: "expected-state",
      });
      await listener.finish({ kind: "signed_in" });
      const response = await answered;
      const html = await response.text();
      expect(await textContent(html, "title")).toBe("Signed in to stella");
      expect(await textContent(html, "h1")).toBe("Signed in to stella");
      expect(await textContent(html, ".wordmark")).toBe("stella");
      expect(await textContent(html, "section")).toContain(
        "Return to your terminal to continue with stella CLI.",
      );
      expect(await textContent(html, "script")).toBe("");
      expect(html).toContain(
        "<bdi>Novák &amp; Partners &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &#39;Legal&#39;</bdi>",
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      const styles = await textContent(html, "style");
      const hash = sha256Base64Url(styles);
      expect(response.headers.get("content-security-policy")).toBe(
        `default-src 'none'; style-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      );
      expect(styles).toContain("prefers-color-scheme: dark");
      expect(html).not.toContain('style="');
      expect(html).not.toContain('src="');
    } finally {
      listener.close();
    }
  });

  test("shows success without an organization when none is known", async () => {
    const listener = await startLoopbackListener({ expectedState: "state" });
    expect(listener).toBeDefined();
    if (!listener) {
      return;
    }
    try {
      const answered = fetch(`${listener.redirectUri}?code=code&state=state`, {
        signal: AbortSignal.timeout(1000),
      });
      await listener.waitForCallback(1000);
      await listener.finish({ kind: "signed_in" });
      const html = await (await answered).text();
      expect(await textContent(html, "h1")).toBe("Signed in to stella");
      expect(html).not.toContain('<p class="organization">');
    } finally {
      listener.close();
    }
  });

  test.each([
    ["a different state", "state=other-state&"],
    ["a state that differs only in length", "state=expected-state-2&"],
    ["no state", ""],
  ])(
    "shows the failure page without query text for %s",
    async (_label, stateQuery) => {
      const listener = await startLoopbackListener({
        expectedState: "expected-state",
      });
      expect(listener).toBeDefined();
      if (!listener) {
        return;
      }
      try {
        const pending = listener.waitForCallback(200);
        const organizationName = "Injected Organization";
        const response = await fetch(
          `${listener.redirectUri}?${stateQuery}code=authorization-code&organization_name=${encodeURIComponent(organizationName)}`,
          { signal: AbortSignal.timeout(1000) },
        );
        const html = await response.text();
        expect(response.status).toBe(400);
        expect(await textContent(html, "h1")).toBe("Sign-in failed");
        expect(html).not.toContain(organizationName);
        expect(html).not.toContain("authorization-code");
        expect(html).not.toContain('<p class="organization">');
        // The code is never handed to the terminal for exchange.
        const callback = await pending;
        if (stateQuery === "") {
          expect(callback).toBeInstanceOf(Error);
        } else {
          expect(callback).toEqual({ error: "invalid_state", kind: "error" });
        }
      } finally {
        listener.close();
      }
    },
  );

  test("shows the failure variant and sends the error to the terminal", async () => {
    const listener = await startLoopbackListener({ expectedState: "xyz789" });
    expect(listener).toBeDefined();
    if (!listener) {
      return;
    }
    try {
      const response = await fetch(
        `${listener.redirectUri}?error=access_denied&error_description=Declined&state=state`,
        { signal: AbortSignal.timeout(1000) },
      );
      const html = await response.text();
      expect(await textContent(html, "title")).toBe("Sign-in failed");
      expect(await textContent(html, "h1")).toBe("Sign-in failed");
      expect(await textContent(html, "section > p")).toBe(
        "Return to your terminal for details, then try signing in to stella CLI again.",
      );
      expect(await textContent(html, ".wordmark")).toBe("stella");
      expect(await listener.waitForCallback(1000)).toEqual({
        kind: "error",
        error: "access_denied",
        errorDescription: "Declined",
        state: "state",
      });
    } finally {
      listener.close();
    }
  });
});

/** Follows a verified redirect the way the browser does after consent. */
const followVerifiedRedirect = async (redirectUri: string) =>
  await fetch(`${redirectUri}?code=authorization-code&state=expected-state`, {
    signal: AbortSignal.timeout(5000),
  });

/** Whether `promise` is still pending after the event loop has had a turn. */
const isPending = async (promise: Promise<unknown>): Promise<boolean> => {
  // real-time: give a premature page time to arrive; a withheld one never does.
  const settled = await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    Bun.sleep(50).then(() => false),
  ]);
  return !settled;
};

describe("the browser waits for the terminal's outcome", () => {
  test("answers success only after finish reports the sign-in", async () => {
    const listener = await startLoopbackListener({
      expectedState: "expected-state",
    });
    if (!listener) {
      throw new Error("listener failed to bind");
    }
    try {
      const answered = followVerifiedRedirect(listener.redirectUri);
      expect(await listener.waitForCallback(1000)).toEqual({
        code: "authorization-code",
        kind: "success",
        state: "expected-state",
      });
      // The code is in the terminal's hands; the browser has no page yet.
      expect(await isPending(answered)).toBe(true);

      await listener.finish({ kind: "signed_in" });
      const response = await answered;
      expect(response.status).toBe(200);
      expect(await textContent(await response.text(), "h1")).toBe(
        "Signed in to stella",
      );
    } finally {
      listener.close();
    }
  });

  test.each([
    [
      "exchange",
      "Sign-in failed",
      "stella CLI could not finish signing in. Return to your terminal for details, then run stella auth login to try again.",
    ],
    [
      "save",
      "Sign-in not saved",
      "stella CLI could not save your sign-in on this computer. Return to your terminal for details, then run stella auth login to try again.",
    ],
  ] as const)(
    "answers the failure page when the %s step fails",
    async (step, heading, message) => {
      const listener = await startLoopbackListener({
        expectedState: "expected-state",
      });
      if (!listener) {
        throw new Error("listener failed to bind");
      }
      try {
        const answered = followVerifiedRedirect(listener.redirectUri);
        await listener.waitForCallback(1000);
        await listener.finish({ kind: "failed", step });

        const response = await answered;
        const html = await response.text();
        expect(response.status).toBe(500);
        expect(await textContent(html, "title")).toBe(heading);
        expect(await textContent(html, "h1")).toBe(heading);
        expect(await textContent(html, "section > p")).toBe(message);
        expect(html).not.toContain("Signed in to stella");
        expect(html).not.toContain("authorization-code");
      } finally {
        listener.close();
      }
    },
  );

  test("answers not confirmed within the bound when no outcome arrives", async () => {
    const completionTimeoutMs = 100;
    const listener = await startLoopbackListener({
      completionTimeoutMs,
      expectedState: "expected-state",
    });
    if (!listener) {
      throw new Error("listener failed to bind");
    }
    try {
      const started = performance.now();
      const answered = followVerifiedRedirect(listener.redirectUri);
      await listener.waitForCallback(1000);

      const response = await answered;
      const elapsed = performance.now() - started;
      const html = await response.text();
      expect(response.status).toBe(504);
      expect(await textContent(html, "h1")).toBe("Sign-in not confirmed");
      expect(await textContent(html, "section > p")).toBe(
        "stella CLI did not confirm the sign-in in time. Return to your terminal; if it is not signed in, run stella auth login to try again.",
      );
      expect(elapsed).toBeGreaterThanOrEqual(completionTimeoutMs - 5);
      expect(elapsed).toBeLessThan(completionTimeoutMs + 2000);

      // A report after the bound cannot turn the answer into success.
      await listener.finish({ kind: "signed_in" });
    } finally {
      listener.close();
    }
  });

  test("closing with a held redirect answers not confirmed", async () => {
    const listener = await startLoopbackListener({
      expectedState: "expected-state",
    });
    if (!listener) {
      throw new Error("listener failed to bind");
    }
    const answered = followVerifiedRedirect(listener.redirectUri);
    await listener.waitForCallback(1000);
    listener.close();

    const response = await answered;
    expect(response.status).toBe(504);
    expect(await textContent(await response.text(), "h1")).toBe(
      "Sign-in not confirmed",
    );
  });

  test("refuses a second redirect while the first is held", async () => {
    const listener = await startLoopbackListener({
      expectedState: "expected-state",
    });
    if (!listener) {
      throw new Error("listener failed to bind");
    }
    try {
      const first = followVerifiedRedirect(listener.redirectUri);
      await listener.waitForCallback(1000);

      const second = await followVerifiedRedirect(listener.redirectUri);
      expect(second.status).toBe(400);
      expect(await textContent(await second.text(), "h1")).toBe(
        "Sign-in failed",
      );

      await listener.finish({ kind: "signed_in" });
      expect((await first).status).toBe(200);
    } finally {
      listener.close();
    }
  });
});
