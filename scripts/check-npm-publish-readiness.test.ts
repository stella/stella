import { describe, expect, test } from "bun:test";

import {
  assessPublishReadiness,
  checkPublishReadiness,
} from "./check-npm-publish-readiness";

const NAME = "@stll/example";
const SHA512 = "ab".repeat(64);
const SLSA = "https://slsa.dev/provenance/v1";

// Same envelope, subject encoding and workflow fields as npm's public SLSA v1
// API, including the tarball digest in both the manifest and statement.
const fixture = ({
  repository = "https://github.com/stella/stella",
  workflow = ".github/workflows/publish-npm.yml",
  subject = "pkg:npm/%40stll/example@1.0.0",
  digest = SHA512,
} = {}) => ({
  name: NAME,
  packument: {
    "dist-tags": { latest: "1.0.0" },
    versions: {
      "1.0.0": {
        name: NAME,
        version: "1.0.0",
        dist: {
          integrity: `sha512-${Buffer.from(SHA512, "hex").toString("base64")}`,
        },
      },
    },
  },
  attestations: {
    attestations: [
      {
        predicateType: SLSA,
        bundle: {
          dsseEnvelope: {
            payload: Buffer.from(
              JSON.stringify({
                _type: "https://in-toto.io/Statement/v1",
                predicateType: SLSA,
                subject: [{ name: subject, digest: { sha512: digest } }],
                predicate: {
                  buildDefinition: {
                    externalParameters: {
                      workflow: {
                        repository,
                        path: workflow,
                        ref: "refs/heads/main",
                      },
                    },
                  },
                },
              }),
            ).toString("base64"),
          },
        },
      },
    ],
  },
});

describe("anonymous npm publishing census", () => {
  test.each(["", "!", "YQ=="])(
    "rejects malformed tarball integrity %j even with a matching subject",
    (encoded) => {
      const evidence = fixture({
        digest: Buffer.from(encoded, "base64").toString("hex"),
      });
      evidence.packument.versions["1.0.0"].dist.integrity = `sha512-${encoded}`;
      expect(assessPublishReadiness(evidence)).toMatchObject({
        status: "failed",
        reason: "unreadable",
      });
    },
  );

  test.each([
    {},
    { "dist-tags": {}, versions: {} },
    { "dist-tags": { latest: "2.0.0" }, versions: { "1.0.0": {} } },
    {
      "dist-tags": { latest: "1.0.0" },
      versions: { "1.0.0": { name: "@stll/other", version: "1.0.0" } },
    },
  ])("never passes a malformed or inconsistent packument: %j", (packument) => {
    expect(assessPublishReadiness({ ...fixture(), packument }).status).toBe(
      "failed",
    );
  });

  test.each([
    {},
    { attestations: "invalid" },
    { attestations: [{ predicateType: SLSA }] },
    {
      attestations: [
        { predicateType: SLSA, bundle: { dsseEnvelope: { payload: "e30=" } } },
      ],
    },
    {
      attestations: [
        {
          predicateType: SLSA,
          bundle: { dsseEnvelope: { payload: "invalid-json" } },
        },
      ],
    },
  ])(
    "refuses malformed provenance rather than losing the census report: %j",
    (attestations) => {
      expect(
        assessPublishReadiness({ ...fixture(), attestations }),
      ).toMatchObject({ status: "failed", reason: "unreadable" });
    },
  );

  test("accepts the latest tarball's repository and calling workflow evidence", () => {
    expect(assessPublishReadiness(fixture()).status).toBe("passed");
  });

  test.each([
    { repository: "https://github.com/another/repository" },
    { workflow: ".github/workflows/other.yml" },
  ])("refuses a different publisher: %j", (identity) => {
    expect(assessPublishReadiness(fixture(identity))).toMatchObject({
      status: "failed",
      reason: "mismatch",
    });
  });

  test.each([
    { subject: "pkg:npm/%40stll/another@1.0.0" },
    { subject: "pkg:npm/%40stll/example@0.9.0" },
    { digest: "cd".repeat(64) },
  ])("requires provenance for this exact latest tarball: %j", (subject) => {
    expect(assessPublishReadiness(fixture(subject))).toMatchObject({
      status: "failed",
      reason: "unreadable",
    });
  });

  test.each([
    null,
    {
      "dist-tags": { latest: "0.0.1-placeholder.0" },
      versions: { "0.0.1-placeholder.0": {} },
    },
  ])("refuses a new or placeholder-only package", (packument) => {
    const verdict = assessPublishReadiness({ ...fixture(), packument });
    expect(verdict).toMatchObject({
      status: "failed",
      reason: "first-publish",
    });
    expect(verdict.detail).toContain("Settings → Trusted publishing");
    expect(verdict.detail).toContain("environment release-app");
    expect(verdict.detail).toContain("within 48 h");
  });

  test.each([null, { attestations: [] }])(
    "refuses an unattested first publish with refresh instructions",
    (attestations) => {
      expect(
        assessPublishReadiness({ ...fixture(), attestations }),
      ).toMatchObject({ status: "failed", reason: "first-publish" });
    },
  );

  test("does not claim that historical evidence reveals current pending, expired or environment settings", () => {
    const verdict = assessPublishReadiness(fixture());
    expect(verdict.status).toBe("passed");
    expect(verdict.detail).toContain(
      "current trust settings are not observable anonymously",
    );
  });

  test.each([401, 403, 429, 500])(
    "does not mistake HTTP %i for a missing package",
    async (status) => {
      const result = await checkPublishReadiness({
        name: NAME,
        fetchImpl: async () => new Response("unavailable", { status }),
      });
      expect(result).toMatchObject({ status: "failed", reason: "unreadable" });
    },
  );

  test("reads only anonymous packument and exact latest attestations endpoints", async () => {
    const requests: string[] = [];
    const evidence = fixture();
    const result = await checkPublishReadiness({
      name: NAME,
      fetchImpl: async (url, options) => {
        requests.push(String(url));
        expect(options?.headers).toBeUndefined();
        return Response.json(
          requests.length === 1 ? evidence.packument : evidence.attestations,
        );
      },
    });
    expect(result.status).toBe("passed");
    expect(requests).toEqual([
      "https://registry.npmjs.org/%40stll%2Fexample",
      "https://registry.npmjs.org/-/npm/v1/attestations/%40stll%2Fexample@1.0.0",
    ]);
  });

  test("reports malformed JSON and missing attestations without dropping a package", async () => {
    expect(
      await checkPublishReadiness({
        name: NAME,
        fetchImpl: async () => new Response("{"),
      }),
    ).toMatchObject({ status: "failed", reason: "unreadable" });
    let request = 0;
    expect(
      await checkPublishReadiness({
        name: NAME,
        fetchImpl: async () => {
          request += 1;
          return request === 1
            ? Response.json(fixture().packument)
            : new Response("", { status: 404 });
        },
      }),
    ).toMatchObject({ status: "failed", reason: "first-publish" });
  });
});
