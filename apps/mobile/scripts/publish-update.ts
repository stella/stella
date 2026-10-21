// Turns one platform's `expo export` output into a signed over-the-air
// update, laid out exactly as the downloads CDN serves it
// (`@stll/api-contract/mobile-updates`):
//
//   <out>/mobile/<variant>/<platform>/<runtime>/<update>/assets/<hash><ext>
//   <out>/mobile/<variant>/<platform>/<runtime>/<update>/manifest.json
//   <out>/mobile/<variant>/<platform>/<runtime>/<update>/manifest.sig
//   <out>/mobile/<variant>/<platform>/<runtime>/latest.json
//
// The signature covers the exact manifest text the API later serves, so a
// phone verifies what was signed here, wherever the bytes travelled.
//
// Usage (the publish workflow runs this):
//   bun scripts/publish-update.ts --variant preview --platform ios \
//     --runtime-version <fingerprint> --dist dist-ios --expo-config config.json \
//     --base-url https://downloads.example.com --key key.pem --out upload

import { panic } from "better-result";
import { sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Temporal } from "temporal-polyfill/full";
import * as v from "valibot";

import {
  MOBILE_APP_VARIANTS,
  type MobileAppVariant,
} from "@stll/api-contract/mobile-client";
import {
  MOBILE_RUNTIME_VERSION_PATTERN,
  MOBILE_UPDATE_PLATFORMS,
  type MobileUpdatePlatform,
  type MobileUpdatePointer,
  type MobileUpdateTarget,
  mobileUpdateAssetKey,
  mobileUpdateManifestKey,
  mobileUpdatePointerKey,
  mobileUpdateSignatureKey,
} from "@stll/api-contract/mobile-updates";
import { sha256Base64Url, sha256Hex } from "@stll/sha256/bun";

/** What `expo export` writes beside the bundle. */
const exportMetadataSchema = v.object({
  fileMetadata: v.record(
    v.string(),
    v.object({
      bundle: v.string(),
      assets: v.array(v.object({ path: v.string(), ext: v.string() })),
    }),
  ),
});

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ttf: "font/ttf",
  otf: "font/otf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  json: "application/json",
};

type ManifestAsset = {
  hash: string;
  key: string;
  fileExtension: string;
  contentType: string;
  url: string;
};

export type UpdateFile = { key: string; bytes: Uint8Array | string };

export type SignedUpdate = {
  updateId: string;
  manifest: string;
  signature: string;
  /** Every object to upload, the pointer last. */
  files: UpdateFile[];
};

/** A UUID-shaped id from a hex digest, as the protocol requires. */
const uuidFromHex = (hex: string): string =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;

export const buildSignedUpdate = ({
  baseUrl,
  createdAt,
  distDir,
  expoConfig,
  privateKeyPem,
  target,
}: {
  baseUrl: string;
  createdAt: string;
  distDir: string;
  expoConfig: unknown;
  privateKeyPem: string;
  target: MobileUpdateTarget;
}): SignedUpdate => {
  const metadata = v.parse(
    exportMetadataSchema,
    JSON.parse(readFileSync(path.join(distDir, "metadata.json"), "utf-8")),
  );
  const exported = metadata.fileMetadata[target.platform];
  if (exported === undefined) {
    panic(`The export holds no ${target.platform} bundle`);
  }
  const read = (relative: string) =>
    new Uint8Array(readFileSync(path.join(distDir, relative)));
  const launch = read(exported.bundle);
  const assets = exported.assets.map((asset) => ({
    ...asset,
    bytes: read(asset.path),
  }));

  // Identical content republished is the same update.
  const updateId = uuidFromHex(
    sha256Hex(
      [
        target.runtimeVersion,
        sha256Hex(launch),
        ...assets.map(({ bytes }) => sha256Hex(bytes)).toSorted(),
      ].join("\n"),
    ),
  );

  const files: UpdateFile[] = [];
  const describe = (
    bytes: Uint8Array,
    extension: string,
    contentType: string,
  ): ManifestAsset => {
    const hex = sha256Hex(bytes);
    const key = mobileUpdateAssetKey(target, updateId, `${hex}${extension}`);
    files.push({ key, bytes });
    return {
      hash: sha256Base64Url(bytes),
      key: hex,
      fileExtension: extension,
      contentType,
      url: `${baseUrl.replace(/\/$/u, "")}/${key}`,
    };
  };

  const manifest = JSON.stringify({
    id: updateId,
    createdAt,
    runtimeVersion: target.runtimeVersion,
    launchAsset: describe(launch, ".bundle", "application/javascript"),
    assets: assets.map(({ bytes, ext }) =>
      describe(
        bytes,
        `.${ext}`,
        CONTENT_TYPES[ext] ?? "application/octet-stream",
      ),
    ),
    metadata: {},
    extra: { expoClient: expoConfig },
  });
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(manifest, "utf-8"),
    privateKeyPem,
  ).toString("base64");

  files.push(
    { key: mobileUpdateManifestKey(target, updateId), bytes: manifest },
    { key: mobileUpdateSignatureKey(target, updateId), bytes: signature },
    {
      key: mobileUpdatePointerKey(target),
      bytes: `${JSON.stringify({ updateId } satisfies MobileUpdatePointer)}\n`,
    },
  );
  return { updateId, manifest, signature, files };
};

const readTarget = (values: {
  variant?: string | undefined;
  platform?: string | undefined;
  "runtime-version"?: string | undefined;
}): MobileUpdateTarget => {
  const variant = MOBILE_APP_VARIANTS.find((name) => name === values.variant);
  const platform = MOBILE_UPDATE_PLATFORMS.find(
    (name) => name === values.platform,
  );
  const runtimeVersion = values["runtime-version"] ?? "";
  if (
    variant === undefined ||
    variant === "development" ||
    platform === undefined ||
    !MOBILE_RUNTIME_VERSION_PATTERN.test(runtimeVersion)
  ) {
    panic(
      "--variant preview|production, --platform ios|android and a fingerprint --runtime-version are required",
    );
  }
  return {
    variant: variant satisfies MobileAppVariant,
    platform: platform satisfies MobileUpdatePlatform,
    runtimeVersion,
  };
};

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      variant: { type: "string" },
      platform: { type: "string" },
      "runtime-version": { type: "string" },
      dist: { type: "string" },
      "expo-config": { type: "string" },
      "base-url": { type: "string" },
      key: { type: "string" },
      out: { type: "string" },
    },
  });
  const { dist, out } = values;
  const baseUrl = values["base-url"];
  const keyPath = values.key;
  const configPath = values["expo-config"];
  if (!dist || !out || !baseUrl || !keyPath || !configPath) {
    panic("--dist, --expo-config, --base-url, --key and --out are required");
  }
  const update = buildSignedUpdate({
    baseUrl,
    createdAt: Temporal.Now.instant().toString(),
    distDir: dist,
    expoConfig: JSON.parse(readFileSync(configPath, "utf-8")),
    privateKeyPem: readFileSync(keyPath, "utf-8"),
    target: readTarget(values),
  });
  for (const file of update.files) {
    const destination = path.join(out, file.key);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, file.bytes);
  }
  process.stdout.write(`${update.updateId}\n`);
}
