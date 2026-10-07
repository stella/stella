import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import {
  createProductMediaManifest,
  PRODUCT_MEDIA_PUBLIC_DIR,
} from "./product-media";

test("product media preserves stored asset bytes and path-framed recording identities", async () => {
  const root = mkdtempSync(nodePath.join(tmpdir(), "sha256-product-media-"));
  try {
    const publicDir = nodePath.join(root, PRODUCT_MEDIA_PUBLIC_DIR);
    mkdirSync(publicDir, { recursive: true });
    writeFileSync(
      nodePath.join(publicDir, "story-editor.mp4"),
      new Uint8Array([0, 255, 1, 128]),
    );
    writeFileSync(
      nodePath.join(publicDir, "story-editor-poster.jpg"),
      new Uint8Array([137, 80, 78, 71, 0, 13, 10]),
    );
    writeFileSync(
      nodePath.join(publicDir, "recordings-manifest.json"),
      JSON.stringify({ entries: [{ captureId: "editor", theme: "light" }] }),
    );
    const manifest = await createProductMediaManifest(root);
    expect(
      manifest.assets.map(({ path, bytes, sha256 }) => ({
        path,
        bytes,
        sha256,
      })),
    ).toEqual([
      {
        path: "media/products/story-editor-poster.jpg",
        bytes: 7,
        sha256:
          "f0898496d3cb2bb288ab440b4f231663d5040f33d0cd8066cd2e543f27db853b",
      },
      {
        path: "media/products/story-editor.mp4",
        bytes: 4,
        sha256:
          "edc81f7e4ee358fb91e94bd9bd74079c3dcba36f40f2c8a36e7ae0567afecc8f",
      },
    ]);
    expect(manifest.recordings).toEqual([
      {
        captureId: "editor",
        theme: "light",
        artifactsHash:
          "2cd1884748431f9d6320af24f213300c4ee5597df12a9efe7c8bef70af069e14",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
