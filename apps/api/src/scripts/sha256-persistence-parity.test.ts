import { expect, test } from "bun:test";

import { createSha256 } from "@stll/sha256/bun";
import { createSha256 as createLegacyNodeHash } from "@stll/sha256/node";

import { hashArtifactBytes } from "./artifact-content-hash";
import { deterministicId } from "./better-auth-17-backfill.logic";
import {
  accountIdentityKeyDigest,
  initializeOAuthPolicyProjection,
  updateAccessPolicyDigest,
  updateAccountIdentityProjection,
  updateOAuthPolicyValue,
  updateTableCensusDigests,
} from "./better-auth-migration-audit.logic";
import { canaryPkceChallenge, canaryVerifierHash } from "./mcp-canary";

for (const text of ["", "ordinary", "Žluťoučký kůň Łódź 📄", "e\u0301"]) {
  test(`artifact identities hash exact bytes before encoding or compression: ${JSON.stringify(text)}`, () => {
    const bytes = new TextEncoder().encode(text);
    const expected = createLegacyNodeHash().update(bytes).digest("hex");
    expect(hashArtifactBytes(text)).toBe(expected);
    expect(hashArtifactBytes(bytes)).toBe(expected);
    expect(hashArtifactBytes(bytes.buffer)).toBe(expected);
    const framed = new Uint8Array(bytes.length + 4);
    framed.set(bytes, 2);
    expect(hashArtifactBytes(framed.subarray(2, -2))).toBe(expected);
  });

  test(`auth backfill IDs preserve trailing NUL framing: ${JSON.stringify(text)}`, () => {
    const values = [text, "", "issuer"];
    const legacy = createLegacyNodeHash();
    for (const value of values) {
      legacy.update(value).update("\0");
    }
    const digest = legacy.digest("hex");
    expect(deterministicId("link", values)).toBe(`better-auth-link-${digest}`);
    expect(deterministicId("resource", values)).toBe(
      `better-auth-resource-${digest}`,
    );
  });

  test(`auth account key and ordered projections retain legacy bytes: ${JSON.stringify(text)}`, () => {
    expect(accountIdentityKeyDigest(text, "account")).toBe(
      createLegacyNodeHash()
        .update(text)
        .update("\0")
        .update("account")
        .digest("hex"),
    );
    const accounts = createSha256();
    const legacyAccounts = createLegacyNodeHash();
    const policy = createSha256();
    const legacyPolicy = createLegacyNodeHash();
    const access = createSha256();
    const legacyAccess = createLegacyNodeHash();
    const keys = createSha256();
    const legacyKeys = createLegacyNodeHash();
    const contents = createSha256();
    const legacyContents = createLegacyNodeHash();
    for (const row of ["first", "second"]) {
      updateAccountIdentityProjection(accounts, row, text, "account");
      for (const value of [row, text, "account"]) {
        legacyAccounts.update(value).update("\0");
      }
      updateOAuthPolicyValue(policy, [row, text, ""]);
      for (const value of [row, text, ""]) {
        legacyPolicy.update(value).update("\0");
      }
      updateAccessPolicyDigest(access, text + row);
      legacyAccess.update(text + row).update("\0");
      const rowContent = JSON.stringify([text, row]);
      updateTableCensusDigests({
        primaryKeyHasher: keys,
        rowContentHasher: contents,
        primaryKey: row,
        rowContent,
      });
      legacyKeys.update(row).update("\0");
      legacyContents.update(row).update("\0").update(rowContent).update("\0");
    }
    expect(accounts.digest("hex")).toBe(legacyAccounts.digest("hex"));
    expect(policy.digest("hex")).toBe(legacyPolicy.digest("hex"));
    expect(access.digest("hex")).toBe(legacyAccess.digest("hex"));
    expect(keys.digest("hex")).toBe(legacyKeys.digest("hex"));
    expect(contents.digest("hex")).toBe(legacyContents.digest("hex"));
  });

  test(`OAuth resource projection preserves sorted legacy frames: ${JSON.stringify(text)}`, () => {
    const resources = [
      { identifier: "z", name: text, allowedScopes: ["write", "read"] },
      { identifier: "a", name: text, allowedScopes: ["read", "read"] },
    ];
    const projected = initializeOAuthPolicyProjection(resources);
    const legacy = createLegacyNodeHash();
    for (const identifier of ["a", "z"]) {
      const scopes = identifier === "a" ? ["read"] : ["read", "write"];
      for (const value of ["resource", identifier, text, ...scopes]) {
        legacy.update(value).update("\0");
      }
    }
    expect(projected.hasher.digest("hex")).toBe(legacy.digest("hex"));
    expect(projected.valid).toBe(false);
  });

  test(`canary PKCE and desktop verifier hashes retain legacy encodings: ${JSON.stringify(text)}`, () => {
    expect(canaryPkceChallenge(text)).toBe(
      createLegacyNodeHash().update(text).digest("base64url"),
    );
    expect(canaryVerifierHash(text)).toBe(
      createLegacyNodeHash().update(text).digest("hex"),
    );
  });
}

test("auth backfill preserves the empty ordered stream", () => {
  const expected = createLegacyNodeHash().digest("hex");
  expect(deterministicId("link", [])).toBe(`better-auth-link-${expected}`);
});
