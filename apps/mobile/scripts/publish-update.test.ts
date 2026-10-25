import { afterAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import {
  mobileUpdatePointerKey,
  mobileUpdatePrefix,
} from "@stll/api-contract/mobile-updates";
import { sha256Base64Url } from "@stll/sha256/bun";

import { buildSignedUpdate } from "./publish-update";

const assetSchema = v.object({
  hash: v.string(),
  url: v.string(),
  contentType: v.string(),
});

/** The parts of a served manifest these tests read. */
const manifestSchema = v.looseObject({
  id: v.string(),
  runtimeVersion: v.string(),
  launchAsset: assetSchema,
  assets: v.array(assetSchema),
});

const TARGET = {
  variant: "preview",
  platform: "ios",
  runtimeVersion: "2965817a6ba1e5b803427be6ba77a293ad958df4",
} as const;

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const directories: string[] = [];
afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { force: true, recursive: true });
  }
});

/** What `expo export --platform ios` writes, in miniature. */
const exportWith = (bundle: string) => {
  const distDir = mkdtempSync(path.join(tmpdir(), "stella-export-"));
  directories.push(distDir);
  mkdirSync(path.join(distDir, "_expo/static/js/ios"), { recursive: true });
  mkdirSync(path.join(distDir, "assets"), { recursive: true });
  writeFileSync(path.join(distDir, "_expo/static/js/ios/entry.hbc"), bundle);
  writeFileSync(path.join(distDir, "assets/abc123"), "png-bytes");
  writeFileSync(
    path.join(distDir, "metadata.json"),
    JSON.stringify({
      version: 0,
      bundler: "metro",
      fileMetadata: {
        ios: {
          bundle: "_expo/static/js/ios/entry.hbc",
          assets: [{ path: "assets/abc123", ext: "png" }],
        },
      },
    }),
  );
  return distDir;
};

const publish = (bundle: string, createdAt = "2026-10-21T08:00:00Z") =>
  buildSignedUpdate({
    baseUrl: "https://downloads.example.test/",
    createdAt,
    distDir: exportWith(bundle),
    expoConfig: { name: "stella Preview" },
    privateKeyPem: privateKey,
    target: TARGET,
  });

describe("a published update", () => {
  test("is signed over the exact manifest text the route serves", () => {
    const update = publish("bundle-1");
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(update.manifest, "utf-8"),
        publicKey,
        Buffer.from(update.signature, "base64"),
      ),
    ).toBe(true);
    // One changed byte no longer verifies.
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${update.manifest} `, "utf-8"),
        publicKey,
        Buffer.from(update.signature, "base64"),
      ),
    ).toBe(false);
  });

  test("lists every asset with the hash a phone checks against its bytes", () => {
    const update = publish("bundle-1");
    const manifest = v.parse(manifestSchema, JSON.parse(update.manifest));
    expect(manifest.runtimeVersion).toBe(TARGET.runtimeVersion);
    expect(manifest.launchAsset.hash).toBe(sha256Base64Url("bundle-1"));
    expect(manifest.launchAsset.contentType).toBe("application/javascript");
    expect(manifest.assets.map(({ hash }) => hash)).toEqual([
      sha256Base64Url("png-bytes"),
    ]);
    const uploaded = new Map(
      update.files.map((file) => [file.key, file.bytes]),
    );
    for (const asset of [manifest.launchAsset, ...manifest.assets]) {
      const key = asset.url.replace("https://downloads.example.test/", "");
      expect(uploaded.has(key)).toBe(true);
      expect(sha256Base64Url(uploaded.get(key) ?? "")).toBe(asset.hash);
    }
  });

  test("stays under its build's prefix and moves the pointer last", () => {
    const update = publish("bundle-1");
    for (const { key } of update.files) {
      expect(key.startsWith(`${mobileUpdatePrefix(TARGET)}/`)).toBe(true);
    }
    expect(update.files.at(-1)).toEqual({
      key: mobileUpdatePointerKey(TARGET),
      bytes: `${JSON.stringify({ updateId: update.updateId })}\n`,
    });
  });

  test("the same content is the same update; new content is a new one", () => {
    const first = publish("bundle-1");
    expect(publish("bundle-1", "2026-10-22T08:00:00Z").updateId).toBe(
      first.updateId,
    );
    expect(publish("bundle-2").updateId).not.toBe(first.updateId);
    expect(first.updateId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
  });
});
