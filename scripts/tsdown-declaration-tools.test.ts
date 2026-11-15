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
    if (!/generator:\s*["'](?:tsgo|tsrs)["']/u.test(source)) {
      continue;
    }

    expect(
      source,
      `${configPath}: resolve declaration tools from the package; fixed paths into node_modules are not allowed`,
    ).not.toMatch(/path:\s*[^\n]*node_modules/u);

    const toolPackages = [
      ...source.matchAll(
        /moduleUrl:\s*import\.meta\.resolve\(["']([^"']+)["']\)/gu,
      ),
    ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
    expect(
      toolPackages,
      `${configPath}: resolve the declaration API from this workspace`,
    ).not.toHaveLength(0);

    const packageJsonPath = path.join(path.dirname(configPath), "package.json");
    const manifest: unknown = await Bun.file(packageJsonPath).json();

    for (const toolPackage of toolPackages) {
      expect(
        manifest,
        `${configPath}: ${toolPackage} must be declared by this workspace`,
      ).toMatchObject({ devDependencies: { [toolPackage]: "catalog:" } });
    }
  }
});
