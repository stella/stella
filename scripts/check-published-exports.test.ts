import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test.each(["exports", "source aliases"])(
  "published exports resolve without a root dependency with %s",
  async (resolution) => {
    const packageDir = await realpath(
      await mkdtemp(path.join(tmpdir(), "published-exports-")),
    );
    const manifestPath = path.join(packageDir, "package.json");
    const manifest = JSON.stringify({
      name: "@stll/published-resolution-fixture",
      version: "1.0.0",
      type: "module",
      exports: {
        ".": "./src/properties.ts",
        "./properties": "./src/properties.ts",
        "./views": "./src/views.ts",
      },
      files: ["dist"],
      scripts: { build: "bun build-fixture.ts" },
    });

    try {
      await Bun.write(manifestPath, manifest);
      if (resolution === "source aliases") {
        await Bun.write(
          path.join(packageDir, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              paths: { "@stll/published-resolution-fixture/*": ["./src/*"] },
            },
          }),
        );
        for (const name of ["properties", "views"]) {
          await Bun.write(
            path.join(packageDir, "src", `${name}.ts`),
            "export const source = true;\n",
          );
        }
        expect(
          Bun.resolveSync(
            "@stll/published-resolution-fixture/views",
            packageDir,
          ),
        ).toBe(path.join(packageDir, "src/views.ts"));
      }
      await Bun.write(
        path.join(packageDir, "build-fixture.ts"),
        `for (const name of ["properties", "views"]) {
        await Bun.write(
          "dist/" + name + ".js",
          "export const value = 1;\\n",
        );
        await Bun.write(
          "dist/" + name + ".d.ts",
          "export declare const value: number;\\n",
        );
      }`,
      );
      const proc = Bun.spawn({
        cmd: [
          process.execPath,
          path.join(import.meta.dir, "check-published-exports.ts"),
          packageDir,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(exitCode, stderr).toBe(0);
      expect(stdout).toContain(
        "3 exports resolve and ship; modules load from dist in Node",
      );
      expect(await Bun.file(manifestPath).text()).toBe(manifest);
    } finally {
      await rm(packageDir, { recursive: true, force: true });
    }
  },
);

const runCheck = async (packageDir: string) => {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      path.join(import.meta.dir, "check-published-exports.ts"),
      packageDir,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, output: stdout + stderr };
};

const writeAssetPatternFixture = async (
  packageDir: string,
  assets: readonly string[],
) => {
  await Bun.write(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "@stll/published-asset-pattern-fixture",
      version: "1.0.0",
      type: "module",
      exports: {
        ".": "./src/index.ts",
        "./capabilities/*.json": "./capabilities/*.json",
      },
      files: ["capabilities", "dist"],
      scripts: { build: "bun build-fixture.ts" },
    }),
  );
  await Bun.write(
    path.join(packageDir, "build-fixture.ts"),
    `await Bun.write("dist/index.js", "export const value = 1;\\n");
     await Bun.write("dist/index.d.ts", "export declare const value: number;\\n");`,
  );
  // The directory exists either way; only its JSON files vary.
  await Bun.write(path.join(packageDir, "capabilities", "README.txt"), "x\n");
  for (const asset of assets) {
    await Bun.write(
      path.join(packageDir, "capabilities", asset),
      JSON.stringify({ id: asset }),
    );
  }
};

test("a shipped asset pattern resolves and every matched file ships", async () => {
  const packageDir = await realpath(
    await mkdtemp(path.join(tmpdir(), "published-asset-pattern-")),
  );
  try {
    await writeAssetPatternFixture(packageDir, ["a.list.json", "b.get.json"]);
    const { exitCode, output } = await runCheck(packageDir);

    expect(exitCode, output).toBe(0);
    expect(output).toContain("2 exports resolve and ship");
  } finally {
    await rm(packageDir, { recursive: true, force: true });
  }
});

test("a shipped asset pattern that matches nothing after the build fails", async () => {
  const packageDir = await realpath(
    await mkdtemp(path.join(tmpdir(), "published-asset-pattern-")),
  );
  try {
    await writeAssetPatternFixture(packageDir, []);
    const { exitCode, output } = await runCheck(packageDir);

    expect(exitCode).not.toBe(0);
    expect(output).toContain(
      'export "./capabilities/*.json" matches no file in capabilities/',
    );
  } finally {
    await rm(packageDir, { recursive: true, force: true });
  }
});
