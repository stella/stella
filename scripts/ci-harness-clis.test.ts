import { describe, expect, test } from "bun:test";

import pins from "../apps/desktop/src-tauri/harness/pins.json" with { type: "json" };
import {
  codexAssetName,
  codexVersionOf,
  pinnedCodexVersion,
  releaseAsset,
} from "./ci-harness-clis";

const DIGEST = "a".repeat(64);

describe("the harness CLIs CI installs", () => {
  test("the Codex version is the one the desktop app pins", () => {
    expect(pinnedCodexVersion(pins)).toBe(pins.codex);
    expect(() => pinnedCodexVersion({ bun: "1.4.4" })).toThrow(
      "no Codex version",
    );
  });

  test("Codex comes as the static binary for the runner's architecture", () => {
    expect(codexAssetName("x64")).toBe("codex-x86_64-unknown-linux-musl.zst");
    expect(codexAssetName("arm64")).toBe(
      "codex-aarch64-unknown-linux-musl.zst",
    );
    expect(() => codexAssetName("ia32")).toThrow("linux-ia32");
  });

  test("the asset is taken only with the SHA-256 digest GitHub reports", () => {
    const name = codexAssetName("x64");
    const url = `https://github.com/openai/codex/releases/download/rust-v1.0.0/${name}`;
    expect(
      releaseAsset(
        {
          assets: [
            { name: "other.zst", browser_download_url: "x", digest: null },
            { name, browser_download_url: url, digest: `sha256:${DIGEST}` },
          ],
        },
        name,
      ),
    ).toEqual({ url, sha256: DIGEST });
    for (const digest of [null, "md5:abc", `sha256:${DIGEST.slice(1)}`]) {
      expect(() =>
        releaseAsset(
          { assets: [{ name, browser_download_url: url, digest }] },
          name,
        ),
      ).toThrow("SHA-256 digest");
    }
    expect(() => releaseAsset({ assets: [] }, name)).toThrow(name);
  });

  test("the installed version is read from `codex --version`", () => {
    expect(codexVersionOf("codex-cli 0.166.0\n")).toBe("0.166.0");
    expect(codexVersionOf("something else")).toBeNull();
  });
});
