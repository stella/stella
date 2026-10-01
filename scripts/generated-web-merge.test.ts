import { panic } from "better-result";
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

const repository = path.resolve(import.meta.dir, "..");
const generators = [
  "apps/api/scripts/generate-web-api-types.ts",
  "apps/web/scripts/generate-route-tree.ts",
];
const revisionGenerator = "scripts/generate-revision-route-tree.ts";
const outputs = [
  "apps/web/src/generated/api-routes.gen.ts",
  "apps/web/src/routeTree.gen.ts",
];

type WriteOptions = { directory: string; file: string; source: string };

const write = ({ directory, file, source }: WriteOptions) => {
  const destination = path.join(directory, file);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, source);
};

// Copy the production import closure, so changes to generator dependencies cannot
// leave a hand-maintained fixture running an obsolete implementation.
type CopyGeneratorOptions = {
  directory: string;
  file: string;
  copied: Set<string>;
};

const copyGenerator = ({ directory, file, copied }: CopyGeneratorOptions) => {
  if (copied.has(file)) {
    return;
  }
  copied.add(file);
  const source = readFileSync(path.join(repository, file), "utf-8");
  write({ directory, file, source });
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of parsed.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith(".")) {
      continue;
    }
    const imported = path.normalize(path.join(path.dirname(file), specifier));
    const resolved = [imported, `${imported}.ts`].find((candidate) =>
      existsSync(path.join(repository, candidate)),
    );
    expect(resolved).toBeDefined();
    if (resolved === undefined) {
      panic(`Missing generator dependency: ${imported}`);
    }
    copyGenerator({ directory, file: resolved, copied });
  }
};

const run = (directory: string, command: string[]) => {
  const result = Bun.spawnSync(command, {
    cwd: directory,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
  expect({
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
  }).toEqual({ exitCode: 0, stderr: "" });
  return result.stdout.toString().trim();
};

const generate = (directory: string, check = false) => {
  for (const generator of generators) {
    run(directory, [
      process.execPath,
      generator,
      ...(check ? ["--check"] : []),
    ]);
  }
};

const fixture = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "stella-generated-merge-"));
  try {
    for (const generator of [...generators, revisionGenerator]) {
      copyGenerator({ directory, file: generator, copied: new Set() });
    }
    write({
      directory,
      file: ".gitignore",
      source: readFileSync(path.join(repository, ".gitignore"), "utf-8"),
    });
    write({
      directory,
      file: "apps/web/package.json",
      source: '{"type":"module","dependencies":{}}',
    });
    write({
      directory,
      file: "apps/api/tsconfig.json",
      source: JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          skipLibCheck: true,
          types: [],
        },
        include: ["src/**/*.ts"],
      }),
    });
    write({
      directory,
      file: "apps/api/src/eden-contract.ts",
      source:
        'import type { Routes } from "./routes";\nexport type WebApiContract = { routes: Routes };\n',
    });
    write({
      directory,
      file: "apps/api/src/routes.ts",
      source:
        "export interface Routes { base: { get: { response: { 200: string } } } }\n",
    });
    write({
      directory,
      file: "apps/web/src/routes/__root.tsx",
      source:
        'import { createRootRoute } from "@tanstack/react-router";\nexport const Route = createRootRoute();\n',
    });
    run(directory, ["git", "init", "-q"]);
    run(directory, ["git", "add", "."]);
    run(directory, [
      "git",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture base",
    ]);
    const checkout = path.join(directory, "checkout");
    run(directory, [
      "git",
      "clone",
      "-q",
      "--no-hardlinks",
      directory,
      checkout,
    ]);
    // Bun resolves isolated dependencies relative to their workspace owner.
    for (const owner of ["", "apps/api", "apps/web", "packages/scripts"]) {
      const dependencies = path.join(repository, owner, "node_modules");
      if (!existsSync(dependencies)) {
        continue;
      }
      const destination = path.join(checkout, owner, "node_modules");
      mkdirSync(path.dirname(destination), { recursive: true });
      symlinkSync(dependencies, destination, "dir");
    }
    return { directory: checkout, temporaryRoot: directory };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
};

test("independent source routes merge cleanly and both generated outputs remain reproducible and untracked", () => {
  const { directory, temporaryRoot } = fixture();
  try {
    const base = run(directory, ["git", "rev-parse", "HEAD"]);
    const branches: string[] = [];
    for (const route of ["alpha", "beta"]) {
      run(directory, ["git", "checkout", "-qb", route, base]);
      write({
        directory,
        file: `apps/api/src/${route}.ts`,
        source: `import "./routes";\ndeclare module "./routes" { interface Routes { ${route}: { get: { response: { 200: "${route}" } } } } }\n`,
      });
      write({
        directory,
        file: `apps/web/src/routes/${route}.tsx`,
        source: `import { createFileRoute } from "@tanstack/react-router";\nexport const Route = createFileRoute("/${route}")({});\n`,
      });
      // Ambient route modules must be reached from the contract's program.
      write({
        directory,
        file: `apps/api/src/${route}.d.ts`,
        source: `import "./${route}";\n`,
      });
      generate(directory);
      run(directory, ["git", "add", "."]);
      run(directory, [
        "git",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        `add ${route}`,
      ]);
      branches.push(run(directory, ["git", "rev-parse", "HEAD"]));
      for (const output of outputs) {
        expect(run(directory, ["git", "ls-tree", "HEAD", "--", output])).toBe(
          "",
        );
      }
    }
    const tree = run(directory, [
      "git",
      "merge-tree",
      "--write-tree",
      "--name-only",
      ...branches,
    ]);
    expect(tree).toMatch(/^[a-f0-9]{40,64}$/u);
    run(directory, ["git", "read-tree", "--reset", "-u", tree]);
    generate(directory);
    const first = outputs.map((output) =>
      readFileSync(path.join(directory, output), "utf-8"),
    );
    for (const generated of first) {
      expect(generated).toContain("alpha");
      expect(generated).toContain("beta");
    }
    generate(directory);
    expect(
      outputs.map((output) =>
        readFileSync(path.join(directory, output), "utf-8"),
      ),
    ).toEqual(first);
    generate(directory, true);
    for (const output of outputs) {
      expect(run(directory, ["git", "ls-tree", tree, "--", output])).toBe("");
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}, 60_000);

test("API determinism check rejects output that changes between generation passes", () => {
  const { directory, temporaryRoot } = fixture();
  try {
    const generator = generators.at(0);
    if (generator === undefined) {
      panic("API generator fixture is missing");
    }
    const file = path.join(directory, generator);
    const source = readFileSync(file, "utf-8");
    const boundary = "const lines = [...HEADER];";
    expect(source.split(boundary)).toHaveLength(2);
    writeFileSync(
      file,
      source.replace(
        boundary,
        'const lines = [...HEADER, "// Mutation: " + performance.now()];',
      ),
    );
    const result = Bun.spawnSync([process.execPath, generator, "--check"], {
      cwd: directory,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toMatch(
      /not deterministic|non.deterministic|not reproducible/iu,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}, 30_000);

test("route tree determinism check rejects output that changes between generation passes", () => {
  const { directory, temporaryRoot } = fixture();
  try {
    const generator = generators.at(1);
    if (generator === undefined) {
      panic("Route tree generator fixture is missing");
    }
    const file = path.join(directory, generator);
    const source = readFileSync(file, "utf-8");
    const boundary = "await new Generator({ config, root: webRoot }).run();";
    expect(source.split(boundary)).toHaveLength(3);
    writeFileSync(
      file,
      source.replaceAll(
        boundary,
        () => `${boundary}
    await writeFile(generatedRouteTree, (await readFile(generatedRouteTree, "utf8")) + "// Mutation: " + performance.now() + "\\n");`,
      ),
    );
    const result = Bun.spawnSync([process.execPath, generator, "--check"], {
      cwd: directory,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toMatch(
      /not deterministic|non.deterministic|not reproducible/iu,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}, 30_000);

test("revision route generation accepts physical sources and rejects executable virtual modules and symlinks before execution", () => {
  const { directory, temporaryRoot } = fixture();
  try {
    write({
      directory,
      file: "apps/web/src/routes/base.tsx",
      source:
        'import { createFileRoute } from "@tanstack/react-router";\nexport const Route = createFileRoute("/base")({});\n',
    });
    run(directory, ["git", "add", "."]);
    run(directory, [
      "git",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "physical route",
    ]);
    const base = run(directory, ["git", "rev-parse", "HEAD"]);
    const output = path.join(temporaryRoot, "revision-tree.ts");
    run(directory, [process.execPath, revisionGenerator, base, output]);
    const tree = readFileSync(output, "utf-8");
    expect(tree).toContain("export const routeTree");
    expect(tree).toContain("/base");
    expect(tree).toContain("./routes/__root");
    const marker = path.join(temporaryRoot, "executed-marker");
    const executableSource = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\nthrow new Error("Revision route source executed");\n`;
    for (const route of ["__virtual.js", "prefix__virtual.js", "linked.js"]) {
      run(directory, ["git", "checkout", "-q", "--detach", base]);
      const routeFile = `apps/web/src/routes/${route}`;
      if (route === "linked.js") {
        write({
          directory,
          file: "executable-route.js",
          source: executableSource,
        });
        symlinkSync(
          "../../../../executable-route.js",
          path.join(directory, routeFile),
        );
      } else {
        write({ directory, file: routeFile, source: executableSource });
      }
      run(directory, ["git", "add", "."]);
      run(directory, [
        "git",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "unsafe route",
      ]);
      const entry = run(directory, ["git", "ls-tree", "HEAD", "--", routeFile]);
      expect(entry).toMatch(
        route === "linked.js" ? /^120000 blob /u : /^100644 blob /u,
      );
      rmSync(output, { force: true });
      const result = Bun.spawnSync(
        [process.execPath, revisionGenerator, "HEAD", output],
        { cwd: directory },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(
        "Revision route generation requires regular physical route files",
      );
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(output)).toBe(false);
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}, 30_000);
