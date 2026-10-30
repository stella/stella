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
  sandboxUrl: "https://app.example.test/api/v1/visual-sandbox/browser",
} satisfies ContentSecurityPolicyEnvironment;

describe("document content security policy", () => {
  test("contains the complete strict allowlist without broad source wildcards", () => {
    const policy = buildContentSecurityPolicy("request-nonce", environment);
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
    const policy = buildContentSecurityPolicy("nonce", environment);
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

  test("admits thumbnail requests and their configured storage redirects", () => {
    const imageDirective = buildContentSecurityPolicy("nonce", environment)
      .split("; ")
      .find((directive) => directive.startsWith("img-src "));
    expect(imageDirective).toBe(
      "img-src 'self' data: blob: https://lh3.googleusercontent.com https://app.example.test https://documents.s3.eu-west-1.amazonaws.com",
    );
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
