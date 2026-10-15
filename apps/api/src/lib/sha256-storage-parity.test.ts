import { expect, test } from "bun:test";

import {
  sha256Hex as legacyHex,
  createSha256 as legacyHasher,
} from "@stll/sha256/node";

import { auditedSkillBody } from "./agent-skills/audited-body";
import { hashSkillPackageContent } from "./agent-skills/content-hash";
import { hashSessionToken } from "./auth/session-token";
import { toSafeId } from "./branded-types";
import { authorizeConfiguredBearer } from "./configured-bearer-access";
import { createS3DeletionEffectChunks } from "./destructive-effect-chunks";
import { reviewDocumentsScopeKey } from "./document-review/review-document-messages";
import { hashOpaqueToken } from "./entities/opaque-tokens";
import { shortToolNameHash } from "./mcp-upstream/namespace";
import { createPkce } from "./mcp-upstream/oauth";
import { createMemoryDedupIdentity } from "./memory/memory-dedup";
import {
  PER_KIND_PERIOD_SCOPE,
  resolveActionPeriodBudget,
} from "./rate-limit/action-period-budget";
import { createAccountAttemptBudget } from "./rate-limit/otp-account-budget";
import {
  brandDerivedPropertyId,
  brandDerivedSampleId,
  brandDerivedCorrespondenceDropId,
} from "./safe-id-boundaries";

const texts = [
  "",
  "abc",
  "Příliš žluťoučký kůň 📄 中文\u0000\ud800",
  "e\u0301",
];
const organizationId = toSafeId<"organization">("parity_org");
const workspaceId = toSafeId<"workspace">(
  "00000000-0000-4000-8000-000000000001",
);

// The Node owner retains the old createHash implementation; production uses Bun.
for (const text of texts) {
  test(`stored token, audit, tool and derived identities preserve createHash bytes: ${JSON.stringify(text)}`, () => {
    const hex = legacyHex(text);
    expect(hashSessionToken(text)).toBe(hex);
    expect(hashOpaqueToken(text)).toBe(hex);
    expect(auditedSkillBody(text)).toEqual({
      sizeBytes: new TextEncoder().encode(text).byteLength,
      sha256: hex,
    });
    expect(shortToolNameHash(text)).toBe(hex.slice(0, 8));
    expect(String(brandDerivedPropertyId(text))).toBe(
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`,
    );
    const sampleHex = hex.slice(0, 32);
    const sampleRaw = `${sampleHex.slice(0, 12)}5${sampleHex.slice(13, 16)}8${sampleHex.slice(17, 32)}`;
    expect(String(brandDerivedSampleId(text))).toBe(
      `${sampleRaw.slice(0, 8)}-${sampleRaw.slice(8, 12)}-${sampleRaw.slice(12, 16)}-${sampleRaw.slice(16, 20)}-${sampleRaw.slice(20, 32)}`,
    );
    const drop = legacyHex(`${workspaceId}:${text}`);
    expect(String(brandDerivedCorrespondenceDropId(workspaceId, text))).toBe(
      `${drop.slice(0, 8)}-${drop.slice(8, 12)}-8${drop.slice(13, 16)}-8${drop.slice(17, 20)}-${drop.slice(20, 32)}`,
    );
  });

  test(`memory and destructive-effect identities preserve canonical bytes: ${JSON.stringify(text)}`, () => {
    const identity = {
      scope: "workspace",
      userId: null,
      workspaceId,
      kind: "fact",
      content: text,
      sourceDataWorkspaceIds: [workspaceId],
    } as const;
    const result = createMemoryDedupIdentity(identity);
    expect(result.dedupKey).toBe(
      legacyHex(
        JSON.stringify({
          version: 1,
          scope: identity.scope,
          userId: null,
          workspaceId,
          kind: identity.kind,
          content: text,
          sourceDataWorkspaceIds: [workspaceId],
        }),
      ),
    );
    const chunks = createS3DeletionEffectChunks([text, "Článek", text]);
    for (const chunk of chunks) {
      expect(chunk.payloadHash).toBe(legacyHex(JSON.stringify(chunk.s3Keys)));
    }
  });

  test(`skill package length-prefixed identities preserve createHash update order: ${JSON.stringify(text)}`, () => {
    const content = {
      name: text,
      description: text,
      body: text,
      version: null,
      license: "",
      compatibility: null,
      metadata: { z: text, a: "" },
      resources: [
        { path: "ž.txt", content: text },
        { path: "a.txt", content: "" },
      ],
    };
    const old = legacyHasher();
    const field = (value: string) => {
      const bytes = new TextEncoder().encode(value);
      old.update(`${bytes.byteLength}:`).update(bytes);
    };
    for (const value of [
      "stella-skill-content-v1",
      text,
      text,
      "absent",
      "",
      "present",
      "",
      "absent",
      "",
      "2",
      "a",
      "",
      "z",
      text,
      text,
      "2",
      "a.txt",
      legacyHex(""),
      "ž.txt",
      legacyHex(text),
    ]) {
      field(value);
    }
    expect(hashSkillPackageContent(content)).toBe(old.digest("hex"));
  });

  test(`account attempt keys preserve normalized email bytes: ${JSON.stringify(text)}`, async () => {
    let observed = "";
    const budget = createAccountAttemptBudget(
      {
        increment: async (key) => {
          observed = key;
          return { count: 1, nextReset: new Date(1000), start: 0 };
        },
        decrement: async () => {},
        complete: async () => undefined,
      },
      {
        counterPrefix: "otp-account",
        budgetFor: () => ({ max: 10, durationMs: 1000 }),
      },
    );
    expect((await budget.reserve(` ${text} `)).isOk()).toBe(true);
    expect(observed.split("\u001f").at(0)).toBe(
      `otp-account:${legacyHex(text.trim().toLowerCase())}`,
    );
  });
}

for (const text of texts.filter((value) => value.trim().length > 0)) {
  test(`pooled and per-kind admission keys preserve current identity format: ${JSON.stringify(text)}`, () => {
    for (const scope of [
      PER_KIND_PERIOD_SCOPE,
      { type: "pooled", poolKey: text } as const,
    ]) {
      const resolved = resolveActionPeriodBudget({
        organizationId,
        identity: { actionKind: text, logicalPhaseId: text },
        policy: { periodMs: 1000, limit: 2 },
        scope,
        nowMs: 1500,
      }).unwrap();
      expect(resolved).not.toBeNull();
      if (resolved === null) {
        return;
      }
      const counter =
        scope.type === "pooled"
          ? `period-pool:${legacyHex(text)}`
          : `period:${legacyHex(text)}`;
      expect(String(resolved.key)).toBe(
        `action-admission:{parity_org}:${counter}:1000:2000`,
      );
      expect(resolved.phaseField).toBe(
        `phase:${legacyHex(scope.type === "pooled" ? JSON.stringify([text, text]) : text)}`,
      );
    }
    expect(
      authorizeConfiguredBearer({
        configuredToken: text,
        authorizationHeader: `Bearer ${text}`,
      }),
    ).toEqual({ status: "authorized" });
    expect(
      authorizeConfiguredBearer({
        configuredToken: text,
        authorizationHeader: `Bearer ${text}x`,
      }),
    ).toEqual({ status: "unauthorized" });
  });
}

test("document review cache keys preserve the ordered version byte stream", () => {
  const target = toSafeId<"entityVersion">(
    "00000000-0000-4000-8000-000000000001",
  );
  const references = [
    toSafeId<"entityVersion">("00000000-0000-4000-8000-000000000002"),
    toSafeId<"entityVersion">("00000000-0000-4000-8000-000000000003"),
  ];
  const old = legacyHasher().update(target);
  for (const reference of references) {
    old.update(reference);
  }
  expect(reviewDocumentsScopeKey(target, references)).toBe(
    `document-review:${old.digest("hex")}`,
  );
});

test("upstream OAuth PKCE retains the unpadded base64url SHA-256 representation", () => {
  const { codeVerifier, codeChallenge } = createPkce();
  expect(codeChallenge).toBe(
    legacyHasher().update(codeVerifier).digest("base64url"),
  );
});
