import { describe, expect, test } from "bun:test";

import {
  authorizationServerMetadataUrls,
  mcpWellKnownProtectedResourceUrls,
} from "@/api/handlers/mcp-connectors/url-safety";

const hrefs = (urls: URL[]): string[] => urls.map((url) => url.href);

describe("mcpWellKnownProtectedResourceUrls (RFC 9728 discovery)", () => {
  test("root path yields only the root-scoped well-known URL", () => {
    expect(
      hrefs(
        mcpWellKnownProtectedResourceUrls(new URL("https://mcp.example.com/")),
      ),
    ).toEqual(["https://mcp.example.com/.well-known/oauth-protected-resource"]);
  });

  test("non-root path yields path-scoped then root-scoped candidates", () => {
    expect(
      hrefs(
        mcpWellKnownProtectedResourceUrls(
          new URL("https://mcp.example.com/mcp"),
        ),
      ),
    ).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    ]);
  });

  test("the full pathname (including nested segments) is appended for the path-scoped candidate", () => {
    const [pathScoped] = mcpWellKnownProtectedResourceUrls(
      new URL("https://mcp.example.com/a/b"),
    );
    expect(pathScoped?.href).toBe(
      "https://mcp.example.com/.well-known/oauth-protected-resource/a/b",
    );
  });

  test("query and fragment on the input do not leak into candidates", () => {
    const urls = mcpWellKnownProtectedResourceUrls(
      new URL("https://mcp.example.com/a/b?token=secret#frag"),
    );
    for (const url of urls) {
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
    }
  });

  test("a non-default port is preserved via origin", () => {
    expect(
      hrefs(
        mcpWellKnownProtectedResourceUrls(new URL("http://localhost:3001/mcp")),
      ),
    ).toEqual([
      "http://localhost:3001/.well-known/oauth-protected-resource/mcp",
      "http://localhost:3001/.well-known/oauth-protected-resource",
    ]);
  });

  test("invariant: every candidate keeps the input origin and the well-known prefix", () => {
    const hosts = ["mcp.example.com", "localhost:3001", "127.0.0.1:8080"];
    const schemes = ["http", "https"] as const;
    const paths = ["/", "/mcp", "/a/b", "/deep/nested/path", "/a/b/"];

    for (let i = 0; i < 200; i++) {
      const scheme = schemes[i % schemes.length];
      const host = hosts[i % hosts.length];
      const path = paths[i % paths.length];
      const input = new URL(`${scheme}://${host}${path}`);
      const urls = mcpWellKnownProtectedResourceUrls(input);

      // Root yields exactly one candidate; any other path yields exactly two.
      expect(urls.length).toBe(input.pathname === "/" ? 1 : 2);
      // The last candidate is always the bare root-scoped well-known URL.
      expect(urls.at(-1)?.href).toBe(
        `${input.origin}/.well-known/oauth-protected-resource`,
      );
      for (const url of urls) {
        expect(url.origin).toBe(input.origin);
        expect(
          url.pathname.startsWith("/.well-known/oauth-protected-resource"),
        ).toBe(true);
      }
    }
  });
});

describe("authorizationServerMetadataUrls (RFC 8414 / OIDC discovery)", () => {
  test("root path yields the two well-known-prefixed metadata URLs", () => {
    expect(
      hrefs(
        authorizationServerMetadataUrls(new URL("https://auth.example.com/")),
      ),
    ).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server",
      "https://auth.example.com/.well-known/openid-configuration",
    ]);
  });

  test("non-root path yields three candidates (two prefixed + one path-suffixed)", () => {
    expect(
      hrefs(
        authorizationServerMetadataUrls(
          new URL("https://auth.example.com/tenant1"),
        ),
      ),
    ).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant1",
      "https://auth.example.com/.well-known/openid-configuration/tenant1",
      "https://auth.example.com/tenant1/.well-known/openid-configuration",
    ]);
  });

  test("a trailing slash is normalized away (identical output to the slash-free path)", () => {
    expect(
      hrefs(
        authorizationServerMetadataUrls(
          new URL("https://auth.example.com/tenant1/"),
        ),
      ),
    ).toEqual(
      hrefs(
        authorizationServerMetadataUrls(
          new URL("https://auth.example.com/tenant1"),
        ),
      ),
    );
  });

  test("nested paths are preserved in all three candidates", () => {
    expect(
      hrefs(
        authorizationServerMetadataUrls(
          new URL("https://auth.example.com/a/b/"),
        ),
      ),
    ).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server/a/b",
      "https://auth.example.com/.well-known/openid-configuration/a/b",
      "https://auth.example.com/a/b/.well-known/openid-configuration",
    ]);
  });

  test("a non-default port is preserved", () => {
    const urls = authorizationServerMetadataUrls(
      new URL("http://localhost:9000/tenant"),
    );
    for (const url of urls) {
      expect(url.origin).toBe("http://localhost:9000");
    }
  });

  test("invariant: candidate count and origin match the input across many shapes", () => {
    const hosts = ["auth.example.com", "localhost:9000", "10.0.0.5:443"];
    const schemes = ["http", "https"] as const;
    const paths = ["/", "/tenant", "/a/b", "/a/b/", "/deep/nested/"];

    for (let i = 0; i < 200; i++) {
      const scheme = schemes[i % schemes.length];
      const host = hosts[i % hosts.length];
      const path = paths[i % paths.length];
      const input = new URL(`${scheme}://${host}${path}`);
      const urls = authorizationServerMetadataUrls(input);

      expect(urls.length).toBe(input.pathname === "/" ? 2 : 3);
      for (const url of urls) {
        expect(url.origin).toBe(input.origin);
        expect(url.pathname).toContain(".well-known");
      }
    }
  });
});
