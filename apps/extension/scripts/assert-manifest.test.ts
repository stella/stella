import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const productionManifest = {
  manifest_version: 3,
  minimum_chrome_version: "128",
  version: "1.2.3",
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'",
  },
  permissions: ["activeTab", "declarativeNetRequest", "scripting", "storage"],
  optional_host_permissions: ["https://*/*"],
  optional_permissions: ["downloads", "webNavigation"],
  content_scripts: [
    { matches: ["https://app.stll.app/*", "https://my.stll.app/*"] },
  ],
};

test("store manifests require the release version and exactly production origins", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "extension-manifest-"));
  const manifestPath = path.join(directory, "manifest.json");
  const check = async (manifest: typeof productionManifest, origins = "") => {
    await Bun.write(manifestPath, JSON.stringify(manifest));
    return Bun.spawnSync(
      [
        process.execPath,
        path.join(import.meta.dirname, "assert-manifest.ts"),
        "production",
        "1.2.3",
        manifestPath,
      ],
      { env: { ...process.env, WXT_STELLA_ORIGINS: origins } },
    );
  };
  try {
    expect((await check(productionManifest)).exitCode).toBe(0);
    const mismatch = await check({ ...productionManifest, version: "0.0.0" });
    expect(mismatch.exitCode).not.toBe(0);
    expect(mismatch.stderr.toString()).toContain(
      "must equal the release version",
    );
    const selfHosted = await check(
      {
        ...productionManifest,
        content_scripts: [{ matches: ["https://other.example/*"] }],
      },
      "https://other.example",
    );
    expect(selfHosted.exitCode).not.toBe(0);
    expect(selfHosted.stderr.toString()).toContain(
      "exactly the production origins",
    );
    for (const origin of [
      "https://staging.stll.app/*",
      "http://localhost/*",
      "https://other.example/*",
    ]) {
      const escaped = await check({
        ...productionManifest,
        content_scripts: [
          {
            matches: [
              ...productionManifest.content_scripts.flatMap(
                ({ matches }) => matches,
              ),
              origin,
            ],
          },
        ],
      });
      expect(escaped.exitCode).not.toBe(0);
      expect(escaped.stderr.toString()).toContain("origin list");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
