import { describe, expect, test } from "bun:test";

import { AUTH_MD_SPEC_VERSION } from "@/api/agent-auth/constants";
import { getAgentAuthManifest } from "@/api/agent-auth/manifest";
import { getAgentAuthMetadataBlock } from "@/api/agent-auth/metadata";
import { env } from "@/api/env";
import { getMcpProtectedResourceMetadata } from "@/api/mcp/metadata";

/**
 * Local-conformance pin: our served discovery shapes must carry exactly the
 * fields the auth.md version we implement requires. This is the second drift
 * direction — the scheduled spec-drift check watches upstream; this test
 * stops OUR code from silently diverging from the pinned contract between
 * bumps. Update the expectations here only alongside a deliberate pin bump.
 */
describe("auth.md conformance (pinned spec version)", () => {
  test("is pinned to the version we built against", () => {
    expect(AUTH_MD_SPEC_VERSION).toBe("0.6.0");
  });

  test("agent_auth block has every v0.6.0 required field", () => {
    const block = getAgentAuthMetadataBlock();

    expect(Object.keys(block).sort()).toEqual(
      [
        "claim_endpoint",
        "events_endpoint",
        "events_supported",
        "identity_assertion",
        "identity_endpoint",
        "identity_types_supported",
        "skill",
      ].sort(),
    );

    // No event schema is advertised until the SET-verification/enforcement
    // phase lands: advertising an event we only acknowledge (never enforce)
    // would let providers treat a 202 as a real, effective revocation.
    expect(block.events_supported).toEqual([]);

    for (const url of [
      block.skill,
      block.identity_endpoint,
      block.claim_endpoint,
      block.events_endpoint,
    ]) {
      expect(() => new URL(url)).not.toThrow();
    }
  });

  test("identity_assertion is advertised only when the ID-JAG flag is on", () => {
    const original = env.FEATURE_AGENT_ID_JAG;
    try {
      // Dark-launched off: discovery must not offer a path the endpoint 403s.
      env.FEATURE_AGENT_ID_JAG = false;
      const off = getAgentAuthMetadataBlock();
      expect(off.identity_types_supported).toEqual([
        "service_auth",
        "anonymous",
      ]);
      expect(off.identity_assertion.assertion_types_supported).toEqual([]);

      env.FEATURE_AGENT_ID_JAG = true;
      const on = getAgentAuthMetadataBlock();
      expect(on.identity_types_supported).toEqual([
        "service_auth",
        "anonymous",
        "identity_assertion",
      ]);
      expect(on.identity_assertion.assertion_types_supported).toEqual([
        "urn:ietf:params:oauth:token-type:id-jag",
      ]);
    } finally {
      env.FEATURE_AGENT_ID_JAG = original;
    }
  });

  test("PRM carries the user-facing v0.6.0 fields agents render at claim time", () => {
    const prm = getMcpProtectedResourceMetadata();

    for (const field of [
      "resource",
      "resource_name",
      "resource_logo_uri",
      "authorization_servers",
      "scopes_supported",
      "bearer_methods_supported",
    ] as const) {
      expect(prm).toHaveProperty(field);
    }

    expect(() => new URL(prm.resource_logo_uri)).not.toThrow();
    expect(prm.bearer_methods_supported).toEqual(["header"]);
  });

  test("manifest names the spec version and the live discovery documents", () => {
    const manifest = getAgentAuthManifest();

    expect(manifest).toContain(`v${AUTH_MD_SPEC_VERSION}`);
    expect(manifest).toContain("/.well-known/oauth-protected-resource");
    expect(manifest).toContain("/.well-known/oauth-authorization-server");
  });
});
