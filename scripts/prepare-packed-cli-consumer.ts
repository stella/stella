import { panic } from "better-result";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

const packedManifestSchema = v.object({
  name: v.string(),
  version: v.string(),
  dependencies: v.optional(v.record(v.string(), v.string())),
  optionalDependencies: v.optional(v.record(v.string(), v.string())),
  peerDependencies: v.optional(v.record(v.string(), v.string())),
});
type PackedPackage = {
  manifest: v.InferOutput<typeof packedManifestSchema>;
  spec: string;
};

const [consumer, ...tarballs] = Bun.argv.slice(2);
if (consumer === undefined || tarballs.length === 0) {
  panic("usage: prepare-packed-cli-consumer.ts <consumer> <tarballs...>");
}
const packages = new Map<string, PackedPackage>();
for (const tarball of tarballs) {
  const file = path.resolve(tarball);
  const manifest = v.parse(
    packedManifestSchema,
    JSON.parse(
      execFileSync("tar", ["-xOf", file, "package/package.json"], {
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
      }),
    ),
  );
  if (packages.has(manifest.name)) {
    panic(`Duplicate packed package: ${manifest.name}`);
  }
  packages.set(manifest.name, { manifest, spec: `file:${file}` });
}
const cli = packages.get("@stll/cli") ?? panic("Missing packed @stll/cli");
const visited = new Set([cli.manifest.name]);
const pending = [cli];
const overrides = new Map<string, string>();
for (const { manifest } of pending) {
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      const dependency = packages.get(name);
      if (dependency === undefined) {
        continue;
      }
      // Validate every edge, even when another path already visited this package.
      if (!Bun.semver.satisfies(dependency.manifest.version, range)) {
        panic(
          `Packed ${name}@${dependency.manifest.version} does not satisfy ${manifest.name} dependency ${range}`,
        );
      }
      if (visited.has(name)) {
        continue;
      }
      visited.add(name);
      overrides.set(name, dependency.spec);
      pending.push(dependency);
    }
  }
}
writeFileSync(
  path.join(consumer, "package.json"),
  JSON.stringify(
    {
      private: true,
      dependencies: { "@stll/cli": cli.spec },
      overrides: Object.fromEntries(overrides),
    },
    null,
    2,
  ),
);
