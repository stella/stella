#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { constants as fsConstants, existsSync, readFileSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import nodePath from "node:path";

const ROOT_DIR = nodePath.resolve(import.meta.dirname, "..");
export const PRODUCT_MEDIA_MANIFEST_PATH =
  "apps/landing/product-media-manifest.json";
export const PRODUCT_MEDIA_PUBLIC_DIR = "apps/landing/public/media/products";
export const PRODUCT_MEDIA_BASE_URL =
  "https://downloads.stll.app/landing/product-media/v1";
export const PRODUCT_MEDIA_OBJECT_PREFIX = "landing/product-media/v1";

const SHA_256_PATTERN = /^[0-9a-f]{64}$/u;
const RECORDING_PATH_PATTERN =
  /^media\/products\/story-[a-z0-9-]+(?:-poster)?\.(?:jpg|mp4)$/u;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY = 4;
const DOWNLOAD_ATTEMPTS = 3;

type SpawnResult = {
  status: number | null;
  stderr: string;
  stdout: string;
};

class ProductMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductMediaError";
  }
}

export type ProductMediaAsset = {
  bytes: number;
  contentType: "image/jpeg" | "video/mp4";
  path: string;
  sha256: string;
};

export type ProductMediaRecording = {
  artifactsHash: string;
  captureId: string;
  theme: "dark" | "light";
};

export type ProductMediaManifest = {
  assets: readonly ProductMediaAsset[];
  baseUrl: string;
  recordings: readonly ProductMediaRecording[];
  version: 1;
};

type RecordingManifestEntry = {
  captureId: string;
  theme: "dark" | "light";
};

export const assertRecordingSourceMatches = (
  manifest: ProductMediaManifest,
  entries: readonly RecordingManifestEntry[],
): void => {
  const sourceKeys = entries
    .map((entry) => `${entry.captureId}:${entry.theme}`)
    .sort();
  const manifestKeys = manifest.recordings
    .map((recording) => `${recording.captureId}:${recording.theme}`)
    .sort();
  if (JSON.stringify(sourceKeys) !== JSON.stringify(manifestKeys)) {
    throw new ProductMediaError(
      `${PRODUCT_MEDIA_MANIFEST_PATH} does not match recordings-manifest.json; regenerate it`,
    );
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isSafeBaseUrl = (value: string): boolean => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const isLoopback =
    url.hostname === "127.0.0.1" || url.hostname === "localhost";
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopback);
};

const isAsset = (value: unknown): value is ProductMediaAsset =>
  isRecord(value) &&
  typeof value["path"] === "string" &&
  RECORDING_PATH_PATTERN.test(value["path"]) &&
  typeof value["sha256"] === "string" &&
  SHA_256_PATTERN.test(value["sha256"]) &&
  typeof value["bytes"] === "number" &&
  Number.isSafeInteger(value["bytes"]) &&
  value["bytes"] > 0 &&
  value["bytes"] <= MAX_ASSET_BYTES &&
  (value["contentType"] === "image/jpeg" ||
    value["contentType"] === "video/mp4");

const isRecording = (value: unknown): value is ProductMediaRecording =>
  isRecord(value) &&
  typeof value["captureId"] === "string" &&
  /^[a-z0-9-]+$/u.test(value["captureId"]) &&
  (value["theme"] === "dark" || value["theme"] === "light") &&
  typeof value["artifactsHash"] === "string" &&
  SHA_256_PATTERN.test(value["artifactsHash"]);

export const validateProductMediaManifest = (
  value: unknown,
): ProductMediaManifest => {
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    typeof value["baseUrl"] !== "string" ||
    !isSafeBaseUrl(value["baseUrl"]) ||
    !Array.isArray(value["assets"]) ||
    !value["assets"].every(isAsset) ||
    !Array.isArray(value["recordings"]) ||
    !value["recordings"].every(isRecording)
  ) {
    throw new TypeError(`${PRODUCT_MEDIA_MANIFEST_PATH} is malformed`);
  }

  const assets = value["assets"];
  const recordings = value["recordings"];
  const paths = new Set<string>();
  for (const asset of assets) {
    if (paths.has(asset.path)) {
      throw new TypeError(
        `${PRODUCT_MEDIA_MANIFEST_PATH} repeats asset path ${asset.path}`,
      );
    }
    const extension = nodePath.extname(asset.path);
    if (
      (extension === ".jpg" && asset.contentType !== "image/jpeg") ||
      (extension === ".mp4" && asset.contentType !== "video/mp4")
    ) {
      throw new TypeError(
        `${PRODUCT_MEDIA_MANIFEST_PATH} has the wrong content type for ${asset.path}`,
      );
    }
    paths.add(asset.path);
  }

  const recordingKeys = new Set<string>();
  for (const recording of recordings) {
    const key = `${recording.captureId}:${recording.theme}`;
    if (recordingKeys.has(key)) {
      throw new TypeError(
        `${PRODUCT_MEDIA_MANIFEST_PATH} repeats recording ${key}`,
      );
    }
    for (const path of recordingArtifactPaths(
      recording.captureId,
      recording.theme,
    )) {
      if (!paths.has(path)) {
        throw new TypeError(
          `${PRODUCT_MEDIA_MANIFEST_PATH} recording ${key} is missing ${path}`,
        );
      }
    }
    recordingKeys.add(key);
  }

  if (recordings.length * 2 !== assets.length) {
    throw new TypeError(
      `${PRODUCT_MEDIA_MANIFEST_PATH} must pair every video with one poster`,
    );
  }

  return {
    assets,
    baseUrl: value["baseUrl"],
    recordings,
    version: 1,
  };
};

export const readProductMediaManifestSync = (
  rootDir = ROOT_DIR,
): ProductMediaManifest => {
  const path = nodePath.join(rootDir, PRODUCT_MEDIA_MANIFEST_PATH);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  return validateProductMediaManifest(parsed);
};

export const assetObjectKey = (asset: ProductMediaAsset): string =>
  `${PRODUCT_MEDIA_OBJECT_PREFIX}/${asset.sha256}${nodePath.extname(asset.path)}`;

export const assetUrl = (
  manifest: ProductMediaManifest,
  asset: ProductMediaAsset,
): string =>
  `${manifest.baseUrl}/${asset.sha256}${nodePath.extname(asset.path)}`;

export const recordingArtifactPaths = (
  captureId: string,
  theme: "dark" | "light",
): readonly [string, string] => {
  const suffix = theme === "dark" ? "-dark" : "";
  const base = `media/products/story-${captureId}${suffix}`;
  return [`${base}.mp4`, `${base}-poster.jpg`];
};

export const recordingArtifactsHashFromManifest = (
  manifest: ProductMediaManifest,
  captureId: string,
  theme: "dark" | "light",
): string | undefined =>
  manifest.recordings.find(
    (recording) =>
      recording.captureId === captureId && recording.theme === theme,
  )?.artifactsHash;

const sha256 = async (path: string): Promise<string> =>
  new Bun.CryptoHasher("sha256").update(await readFile(path)).digest("hex");

const recordingArtifactsHash = async (
  publicDir: string,
  captureId: string,
  theme: "dark" | "light",
): Promise<string> => {
  const hasher = new Bun.CryptoHasher("sha256");
  const paths = recordingArtifactPaths(captureId, theme);
  const contents = await Promise.all(
    paths.map(
      async (path) =>
        await readFile(nodePath.join(publicDir, nodePath.basename(path))),
    ),
  );
  for (const [index, path] of paths.entries()) {
    hasher.update(`apps/landing/public/${path}\0`);
    const content = contents[index];
    if (content === undefined) {
      throw new ProductMediaError(`${path}: recording artifact disappeared`);
    }
    hasher.update(content);
  }
  return hasher.digest("hex");
};

const readRecordingEntries = async (
  rootDir: string,
): Promise<RecordingManifestEntry[]> => {
  const path = nodePath.join(
    rootDir,
    PRODUCT_MEDIA_PUBLIC_DIR,
    "recordings-manifest.json",
  );
  const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
  if (!isRecord(parsed) || !Array.isArray(parsed["entries"])) {
    throw new TypeError(
      "recordings-manifest.json must contain an entries array",
    );
  }
  return parsed["entries"].map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry["captureId"] !== "string" ||
      (entry["theme"] !== "dark" && entry["theme"] !== "light")
    ) {
      throw new TypeError(
        `recordings-manifest.json entry ${index} is malformed`,
      );
    }
    return {
      captureId: entry["captureId"],
      theme: entry["theme"],
    };
  });
};

export const createProductMediaManifest = async (
  rootDir = ROOT_DIR,
): Promise<ProductMediaManifest> => {
  const publicDir = nodePath.join(rootDir, PRODUCT_MEDIA_PUBLIC_DIR);
  const filenames = (await readdir(publicDir))
    .filter((name) => name.endsWith(".mp4") || name.endsWith("-poster.jpg"))
    .sort();
  const assets = await Promise.all(
    filenames.map(async (filename): Promise<ProductMediaAsset> => {
      const path = nodePath.join(publicDir, filename);
      const details = await stat(path);
      return {
        bytes: details.size,
        contentType: filename.endsWith(".mp4") ? "video/mp4" : "image/jpeg",
        path: `media/products/${filename}`,
        sha256: await sha256(path),
      };
    }),
  );
  const entries = await readRecordingEntries(rootDir);
  const recordings = await Promise.all(
    entries.map(async (entry): Promise<ProductMediaRecording> => ({
      artifactsHash: await recordingArtifactsHash(
        publicDir,
        entry.captureId,
        entry.theme,
      ),
      captureId: entry.captureId,
      theme: entry.theme,
    })),
  );
  return validateProductMediaManifest({
    assets,
    baseUrl: PRODUCT_MEDIA_BASE_URL,
    recordings,
    version: 1,
  });
};

const writeManifest = async (rootDir = ROOT_DIR): Promise<void> => {
  const manifest = await createProductMediaManifest(rootDir);
  await writeFile(
    nodePath.join(rootDir, PRODUCT_MEDIA_MANIFEST_PATH),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  process.stdout.write(
    `product-media: wrote ${manifest.assets.length} assets to ${PRODUCT_MEDIA_MANIFEST_PATH}\n`,
  );
};

const verifyFile = async (
  path: string,
  asset: ProductMediaAsset,
): Promise<boolean> => {
  try {
    const details = await stat(path);
    return (
      details.size === asset.bytes && (await sha256(path)) === asset.sha256
    );
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") {
      return false;
    }
    throw error;
  }
};

export const resolveProductMediaCacheDir = (rootDir: string): string => {
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: rootDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0 && typeof result.stdout === "string") {
    const commonDir = result.stdout.trim();
    if (commonDir !== "") {
      return nodePath.join(
        nodePath.resolve(rootDir, commonDir),
        "product-media-cache-v1",
      );
    }
  }
  return nodePath.join(rootDir, ".cache", "product-media-v1");
};

const cloneFile = async (
  source: string,
  destination: string,
): Promise<void> => {
  const temporary = `${destination}.tmp-${String(process.pid)}-${crypto.randomUUID()}`;
  await mkdir(nodePath.dirname(destination), { recursive: true });
  try {
    await copyFile(source, temporary, fsConstants.COPYFILE_FICLONE);
  } catch (error) {
    if (
      !isRecord(error) ||
      (error["code"] !== "ENOTSUP" && error["code"] !== "EINVAL")
    ) {
      throw error;
    }
    await copyFile(source, temporary);
  }
  await rename(temporary, destination);
};

const downloadToCacheOnce = async (
  manifest: ProductMediaManifest,
  asset: ProductMediaAsset,
  cachePath: string,
): Promise<void> => {
  if (await verifyFile(cachePath, asset)) {
    return;
  }
  await mkdir(nodePath.dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.tmp-${String(process.pid)}-${crypto.randomUUID()}`;
  try {
    const response = await fetch(assetUrl(manifest, asset), {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new ProductMediaError(
        `${asset.path}: download returned HTTP ${String(response.status)}`,
      );
    }
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) !== asset.bytes) {
      throw new ProductMediaError(
        `${asset.path}: download size does not match manifest`,
      );
    }
    if (response.body === null) {
      throw new ProductMediaError(`${asset.path}: download returned no body`);
    }
    const payload = new Uint8Array(asset.bytes);
    let offset = 0;
    const reader = response.body.getReader();
    try {
      const readNextChunk = async (): Promise<void> => {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        if (offset + value.byteLength > payload.byteLength) {
          throw new ProductMediaError(
            `${asset.path}: download exceeded manifest size`,
          );
        }
        payload.set(value, offset);
        offset += value.byteLength;
        await readNextChunk();
      };
      await readNextChunk();
    } finally {
      reader.releaseLock();
    }
    if (offset !== payload.byteLength) {
      throw new ProductMediaError(
        `${asset.path}: download size does not match manifest`,
      );
    }
    await writeFile(temporary, payload);
    if (!(await verifyFile(temporary, asset))) {
      throw new ProductMediaError(
        `${asset.path}: downloaded checksum does not match manifest`,
      );
    }
    await rename(temporary, cachePath);
  } finally {
    await rm(temporary, { force: true });
  }
};

const downloadToCache = async (
  manifest: ProductMediaManifest,
  asset: ProductMediaAsset,
  cachePath: string,
): Promise<void> => {
  const attemptDownload = async (attempt: number): Promise<void> => {
    try {
      await downloadToCacheOnce(manifest, asset, cachePath);
    } catch (error) {
      if (attempt >= DOWNLOAD_ATTEMPTS) {
        const detail = error instanceof Error ? error.message : "unknown error";
        throw new ProductMediaError(`${asset.path}: ${detail}`);
      }
      await Bun.sleep(250 * 2 ** (attempt - 1));
      await attemptDownload(attempt + 1);
    }
  };
  await attemptDownload(1);
};

const runBounded = async <T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> => {
  let next = 0;
  const runWorker = async (): Promise<void> => {
    const index = next;
    next += 1;
    const value = values[index];
    if (value === undefined) {
      return;
    }
    await operation(value);
    await runWorker();
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, runWorker),
  );
};

export const syncProductMedia = async (rootDir = ROOT_DIR): Promise<void> => {
  const manifest = readProductMediaManifestSync(rootDir);
  const cacheDir = resolveProductMediaCacheDir(rootDir);
  const uniqueAssets = [
    ...new Map(
      manifest.assets.map((asset) => [
        `${asset.sha256}${nodePath.extname(asset.path)}`,
        asset,
      ]),
    ).values(),
  ];
  await runBounded(uniqueAssets, DOWNLOAD_CONCURRENCY, async (asset) => {
    const extension = nodePath.extname(asset.path);
    const cachePath = nodePath.join(cacheDir, `${asset.sha256}${extension}`);
    const destination = nodePath.join(
      rootDir,
      "apps/landing/public",
      asset.path,
    );
    if (await verifyFile(cachePath, asset)) {
      return;
    }
    if (await verifyFile(destination, asset)) {
      await cloneFile(destination, cachePath);
      return;
    }
    await downloadToCache(manifest, asset, cachePath);
  });
  await runBounded(manifest.assets, DOWNLOAD_CONCURRENCY, async (asset) => {
    const extension = nodePath.extname(asset.path);
    const cachePath = nodePath.join(cacheDir, `${asset.sha256}${extension}`);
    const destination = nodePath.join(
      rootDir,
      "apps/landing/public",
      asset.path,
    );
    if (!(await verifyFile(destination, asset))) {
      await cloneFile(cachePath, destination);
    }
    if (!(await verifyFile(destination, asset))) {
      throw new ProductMediaError(
        `${asset.path}: hydrated file failed checksum verification`,
      );
    }
  });
  process.stdout.write(
    `product-media: verified ${manifest.assets.length} hydrated assets\n`,
  );
};

const requireLocalAssets = async (
  manifest: ProductMediaManifest,
  rootDir: string,
): Promise<void> => {
  await runBounded(manifest.assets, DOWNLOAD_CONCURRENCY, async (asset) => {
    const path = nodePath.join(rootDir, "apps/landing/public", asset.path);
    if (!(await verifyFile(path, asset))) {
      throw new ProductMediaError(
        `${asset.path}: local file does not match manifest`,
      );
    }
  });
};

const publishProductMedia = async (rootDir = ROOT_DIR): Promise<void> => {
  const bucket = process.env["PRODUCT_MEDIA_S3_BUCKET"];
  if (!bucket) {
    throw new ProductMediaError("PRODUCT_MEDIA_S3_BUCKET is required");
  }
  const manifest = readProductMediaManifestSync(rootDir);
  await requireLocalAssets(manifest, rootDir);
  const uniqueAssets = [
    ...new Map(
      manifest.assets.map((asset) => [assetObjectKey(asset), asset]),
    ).values(),
  ];
  for (const asset of uniqueAssets) {
    const key = assetObjectKey(asset);
    const localPath = nodePath.join(rootDir, "apps/landing/public", asset.path);
    const digestBase64 = Buffer.from(asset.sha256, "hex").toString("base64");
    const headArgs = productMediaHeadObjectArgs(bucket, key);
    const existing = runAws(headArgs);
    if (existing.status === 0) {
      assertPublishedObject(existing.stdout, asset, digestBase64);
      continue;
    }
    if (!/(?:404|Not Found|NoSuchKey)/u.test(existing.stderr)) {
      throw new ProductMediaError(
        `${asset.path}: object lookup failed: ${existing.stderr.trim()}`,
      );
    }

    const result = runAws(
      productMediaPutObjectArgs({
        asset,
        bucket,
        digestBase64,
        key,
        localPath,
      }),
    );
    if (result.status !== 0) {
      throw new ProductMediaError(
        `${asset.path}: object upload failed: ${result.stderr.trim()}`,
      );
    }
    const published = runAws(headArgs);
    if (published.status !== 0) {
      throw new ProductMediaError(
        `${asset.path}: uploaded object could not be verified: ${published.stderr.trim()}`,
      );
    }
    assertPublishedObject(published.stdout, asset, digestBase64);
  }
  process.stdout.write(
    `product-media: published ${uniqueAssets.length} immutable objects\n`,
  );
};

const runAws = (args: readonly string[]): SpawnResult => {
  const result = spawnSync("aws", [...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
};

export const productMediaHeadObjectArgs = (
  bucket: string,
  key: string,
): readonly string[] => [
  "s3api",
  "head-object",
  "--bucket",
  bucket,
  "--key",
  key,
  "--checksum-mode",
  "ENABLED",
  "--no-cli-pager",
];

type PutObjectArgsOptions = {
  asset: ProductMediaAsset;
  bucket: string;
  digestBase64: string;
  key: string;
  localPath: string;
};

export const productMediaPutObjectArgs = ({
  asset,
  bucket,
  digestBase64,
  key,
  localPath,
}: PutObjectArgsOptions): readonly string[] => [
  "s3api",
  "put-object",
  "--bucket",
  bucket,
  "--key",
  key,
  "--body",
  localPath,
  "--content-type",
  asset.contentType,
  "--cache-control",
  "public, max-age=31536000, immutable",
  "--checksum-algorithm",
  "SHA256",
  "--checksum-sha256",
  digestBase64,
  "--if-none-match",
  "*",
  "--server-side-encryption",
  "AES256",
  "--no-cli-pager",
];

export const assertPublishedObject = (
  rawHead: string,
  asset: ProductMediaAsset,
  digestBase64: string,
): void => {
  const head: unknown = JSON.parse(rawHead);
  if (
    !isRecord(head) ||
    head["ContentLength"] !== asset.bytes ||
    head["ChecksumSHA256"] !== digestBase64 ||
    typeof head["ServerSideEncryption"] !== "string"
  ) {
    throw new ProductMediaError(
      `${asset.path}: existing object does not match its immutable manifest entry`,
    );
  }
};

const checkProductMedia = async (rootDir = ROOT_DIR): Promise<void> => {
  const manifest = readProductMediaManifestSync(rootDir);
  const recordingEntries = await readRecordingEntries(rootDir);
  assertRecordingSourceMatches(manifest, recordingEntries);
  const localFilesPresent = manifest.assets.some((asset) =>
    existsSync(nodePath.join(rootDir, "apps/landing/public", asset.path)),
  );
  if (localFilesPresent) {
    const generated = await createProductMediaManifest(rootDir);
    if (JSON.stringify(generated) !== JSON.stringify(manifest)) {
      throw new ProductMediaError(
        `${PRODUCT_MEDIA_MANIFEST_PATH} does not match local product media; regenerate it`,
      );
    }
  }
  process.stdout.write(
    `product-media: manifest covers ${manifest.assets.length} assets and ${manifest.recordings.length} recordings\n`,
  );
};

const main = async () => {
  const command = process.argv[2];
  if (command === "write-manifest") {
    await writeManifest();
    return;
  }
  if (command === "check") {
    await checkProductMedia();
    return;
  }
  if (command === "sync") {
    await syncProductMedia();
    return;
  }
  if (command === "publish") {
    await publishProductMedia();
    return;
  }
  throw new ProductMediaError(
    "usage: bun scripts/product-media.ts <write-manifest|check|sync|publish>",
  );
};

if (import.meta.main) {
  await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`product-media: ${message}`);
    process.exit(1);
  });
}
