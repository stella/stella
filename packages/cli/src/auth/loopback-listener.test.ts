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
        throw new Error("expected a LoopbackTimeoutError");
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
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
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
      expect(await listener.waitForCallback(1000)).toEqual({
        kind: "success",
        code: "authorization-code",
        state: "expected-state",
      });
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
      const response = await fetch(
        `${listener.redirectUri}?code=code&state=state`,
        {
          signal: AbortSignal.timeout(1000),
        },
      );
      const html = await response.text();
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
