import { expect, test } from "bun:test";
import path from "node:path";

const trackedTsdownConfigs = () => {
  const result = Bun.spawnSync(["git", "ls-files", "**/tsdown.config.ts"]);
  expect(result.exitCode).toBe(0);

  return result.stdout.toString().trim().split("\n").filter(Boolean);
};

test("every declaration tool is resolved from and declared by its workspace", async () => {
  for (const configPath of trackedTsdownConfigs()) {
    const source = await Bun.file(configPath).text();
    if (!source.includes("tsgo:")) {
      continue;
    }

    expect(
      source,
      `${configPath}: resolve declaration tools from the package; fixed paths into node_modules are not allowed`,
    ).not.toMatch(/path:\s*[^\n]*node_modules/u);

    const toolPackages = [
      ...source.matchAll(
        /resolvePackageBinary\(import\.meta\.url,\s*["']([^"']+)["']\)/gu,
      ),
    ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
    expect(
      toolPackages,
      `${configPath}: name each tsgo.path package with resolvePackageBinary`,
    ).not.toHaveLength(0);

    const packageJsonPath = path.join(path.dirname(configPath), "package.json");
    const manifest = await Bun.file(packageJsonPath).json();
    const declaredPackages = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };

    for (const toolPackage of toolPackages) {
      expect(
        declaredPackages,
        `${configPath}: ${toolPackage} must be a dependency or devDependency of this workspace`,
      ).toHaveProperty(toolPackage);
    }
  }
});
