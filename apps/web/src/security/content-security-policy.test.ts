import { describe, expect, test } from "bun:test";

import {
  buildContentSecurityPolicy,
  type ContentSecurityPolicyEnvironment,
  createContentSecurityPolicyNonce,
  documentsBucketOrigin,
} from "./content-security-policy";

const environment = {
  apiBase: "https://internal-api.example.test/v1",
  browserApiBase: "https://app.example.test/api",
  collabUrl: "wss://collab.example.test/socket",
  desktopBridgePort: 45_901,
  documentsBucket: "documents",
  documentsEndpoint: "https://s3.eu-west-1.amazonaws.com",
  posthogHost: "https://events.example.test/capture",
  sandboxUrls: [
    "https://app.example.test/api/visual-sandbox",
    "https://internal-api.example.test/mcp-app-sandbox",
  ],
} satisfies ContentSecurityPolicyEnvironment;

const NONCE = { kind: "nonce", nonce: "nonce" } as const;

describe("document content security policy", () => {
  test("contains the complete strict allowlist without broad source wildcards", () => {
    const policy = buildContentSecurityPolicy(
      { kind: "nonce", nonce: "request-nonce" },
      environment,
    );
    const directives = policy
      .split("; ")
      .map((directive) => directive.split(" ").at(0));

    expect(directives).toEqual([
      "default-src",
      "script-src",
      "style-src",
      "img-src",
      "font-src",
      "connect-src",
      "worker-src",
      "frame-src",
      "media-src",
      "object-src",
      "base-uri",
      "form-action",
      "frame-ancestors",
    ]);
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).not.toMatch(/(?:^|\s)(?:https:|\*)(?:\s|;|$)/u);
    expect(policy).toContain(
      "script-src 'self' 'nonce-request-nonce' 'strict-dynamic' 'wasm-unsafe-eval' https://events.example.test",
    );
  });

  test("includes each configured origin exactly once", () => {
    const policy = buildContentSecurityPolicy(NONCE, environment);
    const connectDirective = policy
      .split("; ")
      .find((directive) => directive.startsWith("connect-src "));
    expect(connectDirective).toBeDefined();
    for (const expected of [
      "https://events.example.test",
      "wss://collab.example.test",
      "https://documents.s3.eu-west-1.amazonaws.com",
      "http://127.0.0.1:45901",
    ]) {
      expect(connectDirective?.split(expected)).toHaveLength(2);
    }
  });

  test("frames every sandbox the app embeds, each origin once", () => {
    const frameDirective = buildContentSecurityPolicy(NONCE, environment)
      .split("; ")
      .find((directive) => directive.startsWith("frame-src "));
    expect(frameDirective).toBe(
      "frame-src 'self' blob: https://app.example.test https://internal-api.example.test",
    );
  });

  test("admits thumbnail requests and their configured storage redirects", () => {
    const imageDirective = buildContentSecurityPolicy(NONCE, environment)
      .split("; ")
      .find((directive) => directive.startsWith("img-src "));
    expect(imageDirective).toBe(
      "img-src 'self' data: blob: https://lh3.googleusercontent.com https://app.example.test https://documents.s3.eu-west-1.amazonaws.com",
    );
  });

  test("a shareable document admits its inline scripts by hash alone", () => {
    const policy = buildContentSecurityPolicy(
      { kind: "hashes", hashes: ["first-hash", "second-hash"] },
      environment,
    );
    expect(policy).not.toContain("'nonce-");
    expect(policy).toContain(
      "script-src 'self' 'sha256-first-hash' 'sha256-second-hash' 'wasm-unsafe-eval' https://events.example.test;",
    );
    // Every other directive is the private document's.
    const otherDirectives = (value: string) =>
      value
        .split("; ")
        .filter((directive) => !directive.startsWith("script-src "));
    expect(otherDirectives(policy)).toEqual(
      otherDirectives(buildContentSecurityPolicy(NONCE, environment)),
    );
  });

  test("a document without inline scripts admits same-origin files only", () => {
    const scriptDirective = buildContentSecurityPolicy(
      { kind: "hashes", hashes: [] },
      { ...environment, posthogHost: undefined },
    )
      .split("; ")
      .find((directive) => directive.startsWith("script-src "));
    expect(scriptDirective).toBe("script-src 'self' 'wasm-unsafe-eval'");
  });

  test("uses the endpoint origin for path-style self-hosted buckets", () => {
    expect(
      documentsBucketOrigin("https://objects.example.test/storage", "docs"),
    ).toBe("https://objects.example.test");
  });

  test("creates a fresh nonce for every document request", () => {
    expect(createContentSecurityPolicyNonce()).not.toBe(
      createContentSecurityPolicyNonce(),
    );
  });
});
