import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("the bundled publisher gate initializes Redis before installing its deployed client", () => {
  const testDir = mkdtempSync(
    path.join(tmpdir(), "stella-publisher-gate-artifact-"),
  );
  const entrypoint = path.join(testDir, "probe.ts");
  const bundle = path.join(testDir, "probe.js");
  const publisherRequestGate = path.join(
    import.meta.dir,
    "publisher-request-gate.ts",
  );

  try {
    writeFileSync(
      entrypoint,
      `export { createPublisherRequestSlot } from ${JSON.stringify(publisherRequestGate)};\n`,
    );
    const build = Bun.spawnSync({
      cmd: [
        process.execPath,
        "build",
        "--no-autoload-dotenv",
        "--target",
        "bun",
        "--outfile",
        bundle,
        entrypoint,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0);

    const source = readFileSync(bundle, "utf-8");
    const gateMarker = source.lastIndexOf("/publisher-request-gate.ts");
    const gateStart = source.lastIndexOf("// ", gateMarker);
    const gateEnd = source.indexOf("\n// ", gateStart + 1);
    const gateArtifact = source.slice(
      gateStart,
      gateEnd === -1 ? source.length : gateEnd,
    );
    const redisInitialization = gateArtifact.indexOf("init_redis_client");
    const deployedClientInstallation = gateArtifact.indexOf(
      "deployedGateClient = connectedGateClient",
    );

    expect(gateStart).toBeGreaterThanOrEqual(0);
    expect(redisInitialization).toBeGreaterThanOrEqual(0);
    expect(deployedClientInstallation).toBeGreaterThanOrEqual(0);
    expect(redisInitialization).toBeLessThan(deployedClientInstallation);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
}, 30_000);
