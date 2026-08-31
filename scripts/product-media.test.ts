import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import {
  assertRecordingSourceMatches,
  assertPublishedObject,
  assetObjectKey,
  assetUrl,
  PRODUCT_MEDIA_MANIFEST_PATH,
  productMediaPutObjectArgs,
  recordingArtifactPaths,
  resolveProductMediaCacheDir,
  syncProductMedia,
  validateProductMediaManifest,
} from "./product-media";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(
        async (directory) =>
          await rm(directory, { force: true, recursive: true }),
      ),
  );
});

const VIDEO = {
  bytes: 12,
  contentType: "video/mp4" as const,
  path: "media/products/story-editor.mp4",
  sha256: "a".repeat(64),
};
const POSTER = {
  bytes: 8,
  contentType: "image/jpeg" as const,
  path: "media/products/story-editor-poster.jpg",
  sha256: "b".repeat(64),
};
const MANIFEST = {
  assets: [VIDEO, POSTER],
  baseUrl: "https://downloads.example.com/landing/product-media/v1",
  recordings: [
    {
      artifactsHash: "c".repeat(64),
      captureId: "editor",
      theme: "light" as const,
    },
  ],
  version: 1 as const,
};

describe("product media manifest", () => {
  test("derives immutable object keys and URLs from content hashes", () => {
    const manifest = validateProductMediaManifest(MANIFEST);
    expect(assetObjectKey(VIDEO)).toBe(
      `landing/product-media/v1/${"a".repeat(64)}.mp4`,
    );
    expect(assetUrl(manifest, POSTER)).toBe(
      `https://downloads.example.com/landing/product-media/v1/${"b".repeat(64)}.jpg`,
    );
  });

  test("maps light and dark recording pairs to their public paths", () => {
    expect(recordingArtifactPaths("editor", "light")).toEqual([
      "media/products/story-editor.mp4",
      "media/products/story-editor-poster.jpg",
    ]);
    expect(recordingArtifactPaths("editor", "dark")).toEqual([
      "media/products/story-editor-dark.mp4",
      "media/products/story-editor-dark-poster.jpg",
    ]);
  });

  test("rejects traversal and non-TLS remote origins", () => {
    expect(() =>
      validateProductMediaManifest({
        ...MANIFEST,
        assets: [{ ...VIDEO, path: "media/products/../../secret.mp4" }, POSTER],
      }),
    ).toThrow("malformed");
    expect(() =>
      validateProductMediaManifest({
        ...MANIFEST,
        baseUrl: "http://downloads.example.com/assets",
      }),
    ).toThrow("malformed");
  });

  test("requires every recording to have exactly one video and poster", () => {
    expect(() =>
      validateProductMediaManifest({ ...MANIFEST, assets: [VIDEO] }),
    ).toThrow("missing");
    expect(() =>
      validateProductMediaManifest({
        ...MANIFEST,
        assets: [
          VIDEO,
          POSTER,
          { ...POSTER, path: "media/products/story-extra-poster.jpg" },
        ],
      }),
    ).toThrow("pair every video");
  });

  test("rejects recordings omitted from or orphaned in the object manifest", () => {
    expect(() =>
      assertRecordingSourceMatches(MANIFEST, [
        { captureId: "editor", theme: "light" },
        { captureId: "workspace", theme: "dark" },
      ]),
    ).toThrow("does not match recordings-manifest.json");
    expect(() => assertRecordingSourceMatches(MANIFEST, [])).toThrow(
      "does not match recordings-manifest.json",
    );
    expect(() =>
      assertRecordingSourceMatches(MANIFEST, [
        { captureId: "editor", theme: "light" },
      ]),
    ).not.toThrow();
  });

  test("hydrates by checksum and repairs a changed local copy from cache", async () => {
    const rootDir = await mkdtemp(nodePath.join(tmpdir(), "product-media-"));
    temporaryDirectories.push(rootDir);
    execFileSync("git", ["init", "--quiet"], { cwd: rootDir });
    const videoBytes = Buffer.from("video bytes");
    const posterBytes = Buffer.from("poster bytes");
    const assets = [
      {
        ...VIDEO,
        bytes: videoBytes.length,
        sha256: new Bun.CryptoHasher("sha256").update(videoBytes).digest("hex"),
      },
      {
        ...POSTER,
        bytes: posterBytes.length,
        sha256: new Bun.CryptoHasher("sha256")
          .update(posterBytes)
          .digest("hex"),
      },
    ];
    const payloads = new Map([
      [`/${assets[0]?.sha256}.mp4`, videoBytes],
      [`/${assets[1]?.sha256}.jpg`, posterBytes],
    ]);
    let requests = 0;
    const server = Bun.serve({
      fetch(request) {
        requests += 1;
        const payload = payloads.get(new URL(request.url).pathname);
        return payload
          ? new Response(payload, {
              headers: { "content-length": String(payload.length) },
            })
          : new Response("missing", { status: 404 });
      },
      port: 0,
    });
    try {
      const manifest = {
        ...MANIFEST,
        assets,
        baseUrl: `http://127.0.0.1:${String(server.port)}`,
      };
      const manifestPath = nodePath.join(rootDir, PRODUCT_MEDIA_MANIFEST_PATH);
      await mkdir(nodePath.dirname(manifestPath), { recursive: true });
      await writeFile(manifestPath, JSON.stringify(manifest));

      await syncProductMedia(rootDir);
      const videoPath = nodePath.join(
        rootDir,
        "apps/landing/public/media/products/story-editor.mp4",
      );
      expect(await readFile(videoPath)).toEqual(videoBytes);
      expect(requests).toBe(2);

      await writeFile(videoPath, "changed");
      await syncProductMedia(rootDir);
      expect(await readFile(videoPath)).toEqual(videoBytes);
      expect(requests).toBe(2);
    } finally {
      await server.stop(true);
    }
  });

  test("uses a project-local cache when Git metadata is unavailable", async () => {
    const rootDir = await mkdtemp(nodePath.join(tmpdir(), "product-media-"));
    temporaryDirectories.push(rootDir);

    expect(resolveProductMediaCacheDir(rootDir)).toBe(
      nodePath.join(rootDir, ".cache/product-media-v1"),
    );
  });

  test("pins upload checksum, cache policy, and server-side encryption", () => {
    const digestBase64 = Buffer.from(VIDEO.sha256, "hex").toString("base64");
    const args = productMediaPutObjectArgs({
      asset: VIDEO,
      bucket: "media-bucket",
      digestBase64,
      key: assetObjectKey(VIDEO),
      localPath: "/tmp/video.mp4",
    });
    expect(args).toContain("public, max-age=31536000, immutable");
    expect(args).toContain(digestBase64);
    expect(args).toContain("--if-none-match");
    expect(args).toContain("AES256");
    expect(() =>
      assertPublishedObject(
        JSON.stringify({
          ChecksumSHA256: digestBase64,
          ContentLength: VIDEO.bytes,
          ServerSideEncryption: "AES256",
        }),
        VIDEO,
        digestBase64,
      ),
    ).not.toThrow();
    expect(() =>
      assertPublishedObject(
        JSON.stringify({
          ChecksumSHA256: "wrong",
          ContentLength: VIDEO.bytes,
          ServerSideEncryption: "AES256",
        }),
        VIDEO,
        digestBase64,
      ),
    ).toThrow("does not match");
  });
});
