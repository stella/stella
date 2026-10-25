import { panic } from "better-result";
import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { API } from "tsrs/unstable/async";
import * as v from "valibot";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  BUN_FLAGS,
  checkDockerSource,
  checkRepositoryDockerSources,
  commandEntries,
  copySource,
  dockerInstructions,
  dockerPruneScopes,
  inDockerContext,
  installToolingCopies,
  sourceClosureProblems,
  type SourceTree,
  updateInstallToolingCopies,
} from "./docker-source-closure";
import { GENERATORS } from "./generated-files";
import { lexShell, parseBunFlags, programWords } from "./install-free-ci";
import { workflowJobSteps } from "./workflow-steps";

const root = mkdtempSync(path.join(tmpdir(), "docker-source-fixtures-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const put = (file: string, source: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), source);
  return file;
};
const tree = (files: readonly string[]): SourceTree =>
  new Map(files.map((file) => [`/app/${file}`, file]));

describe("Docker source closure", () => {
  test("API install tooling COPY lines match the complete runtime import closure", async () => {
    await updateInstallToolingCopies(
      path.resolve(import.meta.dir, ".."),
      false,
    );
  });

  test("install tooling copies derive transitive imports and reject omitted modules", async () => {
    const entry = put(
      "install-tooling/entry.ts",
      'import { value } from "./store"; import type { Options } from "./types"; console.log(value);',
    );
    const store = put(
      "install-tooling/store.ts",
      'export { value } from "./hash";',
    );
    const hash = put(
      "install-tooling/hash.ts",
      'import "node:crypto"; export const value = "ready";',
    );
    const files = tree([entry, store, hash]);
    const copies = await installToolingCopies({
      root,
      files,
      entry: `/app/${entry}`,
    });
    expect(copies.split("\n")).toEqual(
      [entry, hash, store].map((file) => `COPY ${file} ${file}`),
    );
    const context = new Map([...files].map(([, file]) => [`/${file}`, file]));
    const source = `FROM oven/bun AS base\nWORKDIR /app\n${copies}\nRUN bun ${entry}\n`;
    expect(await checkDockerSource(root, source, context, new Map())).toEqual(
      [],
    );
    expect(
      await checkDockerSource(
        root,
        source.replace(`COPY ${hash} ${hash}\n`, ""),
        context,
        new Map(),
      ),
    ).toEqual([`${store} imports ./hash, unavailable in Docker stage`]);
    expect(
      await rejectionOf(
        installToolingCopies({
          root,
          files: tree([entry, store]),
          entry: `/app/${entry}`,
        }),
      ),
    ).toMatchObject({
      message: expect.stringContaining(
        "imports ./hash, unavailable in Docker stage",
      ),
    });
  });

  test("preinstall copy generation refuses imports that need an install or runtime discovery", async () => {
    for (const [file, source, error] of [
      [
        "install-tooling/external.ts",
        'import "valibot";',
        "requires a relative import or builtin",
      ],
      [
        "install-tooling/dynamic.ts",
        'const target = "./x.ts";\nimport(target);',
        "nonliteral runtime import",
      ],
    ] as const) {
      const entry = put(file, source);
      expect(
        await rejectionOf(
          installToolingCopies({
            root,
            files: tree([entry]),
            entry: `/app/${entry}`,
          }),
        ),
      ).toMatchObject({ message: expect.stringContaining(error) });
    }
  });
  test("every API image install uses the bounded installer owner", () => {
    const source = readFileSync(
      new URL("../apps/api/Dockerfile", import.meta.url),
      "utf-8",
    );
    const unboundedInstalls = (dockerfile: string) =>
      dockerInstructions(dockerfile).flatMap((instruction) => {
        if (!instruction.startsWith("RUN ")) {
          return [];
        }
        const command = instruction.replace(/^RUN\s+(?:--mount=\S+\s+)*/u, "");
        return lexShell(command).flatMap((event) => {
          if (event.type !== "command") {
            return [];
          }
          const words = programWords(event.words);
          if (path.posix.basename(words.at(0) ?? "") !== "bun") {
            return [];
          }
          const flags = parseBunFlags({
            args: words.slice(1),
            context: { root, checkouts: [], expanding: new Set() },
            cwd: ".",
            stdin: event.stdin?.body,
          });
          if (flags.type === "classified") {
            return flags.classification.type === "unclassified"
              ? [command]
              : [];
          }
          return ["install", "i", "ci", "add"].includes(
            flags.positional.at(0) ?? "",
          )
            ? [command]
            : [];
        });
      });
    expect(source).toContain(
      "bun scripts/ci-install.ts /tmp/deps-install.log --filter @stll/api",
    );
    expect(unboundedInstalls(source)).toEqual([]);
    for (const command of [
      "bun install",
      "BUN_INSTALL_GLOBAL_STORE=0 bun i",
      "env bun ci",
      "bun add -g turbo",
      "bun --filter @stll/api install",
      "/usr/bin/bun --cwd /app ci",
    ]) {
      expect(unboundedInstalls(`${source}\nRUN ${command}`)).toEqual([command]);
    }
  });
  test("checks the sandbox install and cache commands without hiding source runners", async () => {
    const source = readFileSync(
      new URL(
        "../packages/agent-engine/docker/sandbox.Dockerfile",
        import.meta.url,
      ),
      "utf-8",
    );
    expect(await checkDockerSource(root, source, new Map(), new Map())).toEqual(
      [],
    );
    expect(
      await checkDockerSource(
        root,
        `${source}\nRUN bun absent.ts`,
        new Map(),
        new Map(),
      ),
    ).toEqual(["Entry is unavailable: /workspace/absent.ts"]);
    for (const command of [
      "npm cache clean",
      "npm cache clean --force extra",
      "npm cache clean --force --prefix scripts",
      "npm cache verify",
      'npm "cache clean --force"',
    ]) {
      expect(
        await rejectionOf(commandEntries(root, new Map(), command, "/app")),
      ).toMatchObject({
        message: expect.stringContaining("Unsupported source runner: npm"),
      });
    }
  });
  test("keeps commands after comment lines in a continued instruction", () => {
    for (const newline of ["\n", "\r\n"]) {
      expect(
        dockerInstructions(
          ["RUN bun first.ts \\", "  # comment", "  && bun second.ts"].join(
            newline,
          ),
        ),
      ).toEqual(["RUN bun first.ts    && bun second.ts"]);
    }
  });

  test("continued instructions retain commands across whitespace and blank lines", async () => {
    for (const newline of ["\n", "\r\n"]) {
      for (const suffix of [" ", "\t", " \t"]) {
        const source = [
          "FROM bun AS builder",
          "WORKDIR /app",
          `RUN true \\${suffix}`,
          "",
          "  # BuildKit ignores comments and empty continuation lines",
          " \t",
          "  && bun absent.ts",
        ].join(newline);
        expect(
          await checkDockerSource(root, source, new Map(), new Map()),
        ).toEqual(["Entry is unavailable: /app/absent.ts"]);
      }
    }
  });

  test("a packaged build output copied from another stage runs without a source closure", async () => {
    const stages = [
      "FROM bun AS builder",
      "FROM bun AS runner",
      "COPY --from=builder /app/bundles/ /app/",
    ];
    expect(
      await checkDockerSource(
        root,
        [...stages, "FROM runner AS smoke", "RUN bun /app/smoke.js"].join("\n"),
        new Map(),
        new Map(),
      ),
    ).toEqual([]);
    expect(
      await checkDockerSource(
        root,
        [...stages, "RUN bun /opt/absent.js"].join("\n"),
        new Map(),
        new Map(),
      ),
    ).toEqual(["Entry is unavailable: /opt/absent.js"]);
  });

  test.each(["/", "/./", "/nested/.."])(
    "root-copied packaged artifacts retain a single separator: %s",
    async (destination) => {
      for (const entry of ["/smoke.js", "/app/smoke.js"]) {
        expect(
          await checkDockerSource(
            root,
            [
              "FROM bun AS builder",
              "FROM bun AS runner",
              `COPY --from=builder /packaged/ ${destination}`,
              "FROM runner AS smoke",
              `RUN bun ${entry}`,
            ].join("\n"),
            new Map(),
            new Map(),
          ),
        ).toEqual([]);
      }
    },
  );

  test("source wrappers check their inner reads without splitting quoted arguments", async () => {
    const entry = put("wrapper/entry.ts", 'import "./missing";');
    const context: SourceTree = new Map([["/entry.ts", entry]]);
    for (const prefix of [
      "env VAR=x",
      "timeout 10s",
      "nice",
      "nice -n 3",
      "nice --adjustment=-2",
      "exec",
      "env VAR=x timeout 10s nice -n 3 exec",
    ]) {
      expect(
        await checkDockerSource(
          root,
          `FROM bun AS builder\nWORKDIR /app\nCOPY entry.ts .\nRUN ${prefix} bun entry.ts`,
          context,
          new Map(),
        ),
      ).toEqual([
        "wrapper/entry.ts imports ./missing, unavailable in Docker stage",
      ]);
      expect(
        await commandEntries(
          root,
          tree(["entry.ts"]),
          `${prefix} bun absent.ts`,
          "/app",
        ),
      ).toEqual(["/app/absent.ts"]);
      expect(
        await commandEntries(
          root,
          tree(["entry.ts"]),
          `${prefix} bun 'entry with spaces.ts'`,
          "/app",
        ),
      ).toEqual(["/app/entry with spaces.ts"]);
    }
    for (const shell of ["sh", "bash"]) {
      expect(
        await checkDockerSource(
          root,
          `FROM bun AS builder\nWORKDIR /app\nCOPY entry.ts .\nRUN ${shell} -c 'bun entry.ts'`,
          context,
          new Map(),
        ),
      ).toEqual([
        "wrapper/entry.ts imports ./missing, unavailable in Docker stage",
      ]);
      expect(
        await commandEntries(
          root,
          new Map(),
          `${shell} -c 'true && bun absent.ts'`,
          "/app",
        ),
      ).toEqual(["/app/absent.ts"]);
    }
    for (const command of [
      "nohup bun absent.ts",
      "unknown 'bun absent.ts'",
      "env --unknown bun entry.ts",
      "timeout --unknown bun entry.ts",
      "nice --unknown bun entry.ts",
    ]) {
      expect(
        await rejectionOf(
          commandEntries(root, tree(["entry.ts"]), command, "/app"),
        ),
      ).toMatchObject({
        message: expect.stringMatching(/Unsupported source wrapper/u),
      });
    }
  });

  test("external COPY assets are opaque and cannot supply source inventory", async () => {
    for (const from of ["oven/bun:1", "unmodelled", "0"]) {
      const source = `FROM bun AS builder\nWORKDIR /app\nCOPY --from=${from} /usr/bin/bun /usr/bin/bun`;
      expect(
        await checkDockerSource(root, source, new Map(), new Map()),
      ).toEqual([]);
      expect(
        await checkDockerSource(
          root,
          `${source}\nRUN bun entry.ts`,
          new Map(),
          new Map(),
        ),
      ).toEqual(["Entry is unavailable: /app/entry.ts"]);
    }
    expect(
      await rejectionOf(
        checkDockerSource(
          root,
          "FROM bun AS builder\nCOPY --from=pruner /app/src /app/src",
          new Map(),
          new Map(),
        ),
      ),
    ).toMatchObject({
      message: expect.stringContaining("Unknown COPY stage: pruner"),
    });
  });

  test("copies multiple source contents into one destination", async () => {
    const entry = put("multi-copy/apps/entry.ts", 'import "./dependency";');
    const dependency = put(
      "multi-copy/packages/dependency.ts",
      "export const value = 1;",
    );
    const asset = put("multi-copy/data.json", "{}");
    const context: SourceTree = new Map([
      ["/apps/entry.ts", entry],
      ["/packages/dependency.ts", dependency],
      ["/data.json", asset],
    ]);
    const dockerfile =
      "FROM bun AS builder\nWORKDIR /app\nCOPY apps packages data.json ./\nRUN bun entry.ts";
    expect(
      await checkDockerSource(root, dockerfile, context, new Map()),
    ).toEqual([]);
    expect(
      await rejectionOf(
        checkDockerSource(
          root,
          dockerfile.replace("./", "destination"),
          context,
          new Map(),
        ),
      ),
    ).toMatchObject({
      message: expect.stringContaining(
        "Multiple COPY sources require a directory destination",
      ),
    });
    expect(
      await checkDockerSource(
        root,
        dockerfile.replace("bun entry.ts", "bun apps/entry.ts"),
        context,
        new Map(),
      ),
    ).toEqual(["Entry is unavailable: /app/apps/entry.ts"]);
  });

  test("COPY and ADD infer existing destination directories for single and multiple files", async () => {
    const entry = put(
      "existing-directory/src/entry.ts",
      'import "./helper"; import "./second";',
    );
    const helper = put(
      "existing-directory/helper.ts",
      "export const helper = 1;",
    );
    const second = put(
      "existing-directory/second.ts",
      "export const second = 2;",
    );
    const context: SourceTree = new Map([
      ["/src/entry.ts", entry],
      ["/helper.ts", helper],
      ["/second.ts", second],
    ]);
    for (const operation of ["COPY", "ADD"]) {
      for (const copies of [
        `${operation} helper.ts /app/src\n${operation} second.ts /app/src`,
        `${operation} helper.ts second.ts /app/src`,
      ]) {
        const dockerfile = `FROM bun\nWORKDIR /app\n${operation} src /app/src\n${copies}\nRUN bun src/entry.ts`;
        expect(
          await checkDockerSource(root, dockerfile, context, new Map()),
        ).toEqual([]);
      }
      expect(
        await rejectionOf(
          checkDockerSource(
            root,
            `FROM bun\nWORKDIR /app\n${operation} helper.ts second.ts /app/not-a-directory`,
            context,
            new Map(),
          ),
        ),
      ).toMatchObject({
        message: expect.stringContaining(
          `Multiple ${operation} sources require a directory destination`,
        ),
      });
      expect(
        await rejectionOf(
          checkDockerSource(
            root,
            `FROM bun\nWORKDIR /app\n${operation} helper.ts /app/not-a-directory\n${operation} helper.ts second.ts /app/not-a-directory`,
            context,
            new Map(),
          ),
        ),
      ).toMatchObject({
        message: expect.stringContaining(
          `Multiple ${operation} sources require a directory destination`,
        ),
      });
      expect(
        await checkDockerSource(
          root,
          `FROM bun\nWORKDIR /app\n${operation} helper.ts second.ts /app\nRUN bun helper.ts`,
          context,
          new Map(),
        ),
      ).toEqual([]);
    }
    const destination: SourceTree = new Map([["/app/src/entry.ts", entry]]);
    copySource(context, destination, "/helper.ts", "/app/src");
    expect(destination.get("/app/src/helper.ts")).toBe(helper);
    expect(destination.has("/app/src")).toBe(false);
  });

  test("cached import edges retain content and stage inventory boundaries", async () => {
    const first = put("import-cache/first.ts", 'import "./first-dependency";');
    const second = put(
      "import-cache/second.ts",
      'import "./second-dependency";',
    );
    const dependency = put(
      "import-cache/first-dependency.ts",
      "export const value = 1;",
    );
    const complete: SourceTree = new Map([
      ["/app/entry.ts", first],
      ["/app/first-dependency.ts", dependency],
    ]);
    const omitted: SourceTree = new Map([["/app/entry.ts", first]]);
    const replaced: SourceTree = new Map([["/app/entry.ts", second]]);
    expect(
      await sourceClosureProblems(root, complete, ["/app/entry.ts"]),
    ).toEqual([]);
    expect(
      await sourceClosureProblems(root, omitted, ["/app/entry.ts"]),
    ).toEqual([
      "import-cache/first.ts imports ./first-dependency, unavailable in Docker stage",
    ]);
    expect(
      await sourceClosureProblems(root, replaced, ["/app/entry.ts"]),
    ).toEqual([
      "import-cache/second.ts imports ./second-dependency, unavailable in Docker stage",
    ]);
  });

  test("conditional workspace exports reject unmodeled custom Bun conditions", async () => {
    const files = [
      put(
        "conditions/package.json",
        JSON.stringify({
          name: "@stll/conditional",
          exports: {
            ".": {
              production: "./production.ts",
              default: "./default.ts",
            },
          },
        }),
      ),
      put("conditions/default.ts", "export const value = 1;"),
      put("conditions-entry.ts", 'import "@stll/conditional";'),
    ];
    put("conditions/production.ts", 'import "./production-only-missing";');
    const inventory = tree(files);
    expect(
      await sourceClosureProblems(root, inventory, [
        "/app/conditions-entry.ts",
      ]),
    ).toEqual([]);
    for (const mode of ["run", "build"]) {
      for (const flag of [
        "--conditions=production",
        "--conditions production",
        "-C production",
      ]) {
        expect(
          await rejectionOf(
            commandEntries(
              root,
              inventory,
              `bun ${mode} ${flag} conditions-entry.ts`,
              "/app",
            ),
          ),
        ).toMatchObject({
          message: expect.stringContaining("Unsupported Bun flag semantics"),
        });
      }
    }
  });

  test("source mutations remove inventory and unknown writers fail closed before runners", async () => {
    const entry = put("mutation/entry.ts", 'import "./helper";');
    const helper = put("mutation/helper.ts", "export const value = 1;");
    const context: SourceTree = new Map([
      ["/entry.ts", entry],
      ["/helper.ts", helper],
    ]);
    const prefix = "FROM bun\nWORKDIR /app\nCOPY . .\nRUN ";
    for (const command of [
      "rm helper.ts && bun entry.ts",
      "rm -rf /app/helper.ts && bun entry.ts",
      "mv helper.ts moved.ts && bun entry.ts",
      "mv helper.ts moved.ts\nRUN bun entry.ts",
      "rm -rf /app && bun entry.ts",
      "rmdir /app && bun entry.ts",
    ]) {
      expect(
        (
          await checkDockerSource(root, prefix + command, context, new Map())
        ).join("\n"),
      ).toMatch(/unavailable in Docker stage|Entry is unavailable/u);
    }
    expect(
      await checkDockerSource(
        root,
        `${prefix}mv helper.ts moved.ts && bun moved.ts`,
        context,
        new Map(),
      ),
    ).toEqual([]);
    expect(
      await checkDockerSource(
        root,
        `${prefix}false && mv helper.ts moved.ts; bun moved.ts`,
        context,
        new Map(),
      ),
    ).toEqual(["Entry is unavailable: /app/moved.ts"]);
    expect(
      await checkDockerSource(
        root,
        `${prefix}cp helper.ts copied.ts && bun copied.ts`,
        context,
        new Map(),
      ),
    ).toEqual([]);
    expect(
      await checkDockerSource(
        root,
        `${prefix}false && cp helper.ts copied.ts; bun copied.ts`,
        context,
        new Map(),
      ),
    ).toEqual(["Entry is unavailable: /app/copied.ts"]);
    expect(
      await rejectionOf(
        checkDockerSource(
          root,
          `${prefix}cp absent.ts helper.ts && bun entry.ts`,
          context,
          new Map(),
        ),
      ),
    ).toMatchObject({
      message: expect.stringContaining(
        "cp source is unavailable: /app/absent.ts",
      ),
    });
    expect(
      await rejectionOf(
        checkDockerSource(
          root,
          `${prefix}cp --unknown helper.ts copied.ts && bun entry.ts`,
          context,
          new Map(),
        ),
      ),
    ).toMatchObject({
      message: expect.stringContaining(
        "Unsupported source mutation: cp touches /app/helper.ts",
      ),
    });
    for (const command of [
      "sed -i helper.ts && bun entry.ts",
      "sed -i helper.ts\nRUN bun entry.ts",
    ]) {
      expect(
        await rejectionOf(
          checkDockerSource(root, prefix + command, context, new Map()),
        ),
      ).toMatchObject({
        message: expect.stringContaining(
          "Unsupported source mutation: sed touches /app/helper.ts",
        ),
      });
    }
    expect(
      await checkDockerSource(
        root,
        `${
          prefix
        }rm -rf /var/lib/apt/lists/* /root/.bun/install/cache && bun entry.ts`,
        context,
        new Map(),
      ),
    ).toEqual([]);
  });

  test("literal cp supports source reads, overwrites, directories and preservation flags", async () => {
    const entry = put("literal-cp/entry.ts", 'import "./helper";');
    const helper = put("literal-cp/helper.ts", "export const value = 1;");
    const replacement = put("literal-cp/replacement.ts", 'import "./absent";');
    const context: SourceTree = new Map([
      ["/entry.ts", entry],
      ["/helper.ts", helper],
      ["/replacement.ts", replacement],
      ["/src/marker.ts", helper],
      ["/folder/helper.ts", helper],
      ["/apps/api/src/lib/ocr-local/latin-v5-dict.txt", helper],
    ]);
    const prefix = "FROM bun\nWORKDIR /app\nCOPY . .\nRUN ";
    expect(
      await checkDockerSource(
        root,
        `${prefix}cp apps/api/src/lib/ocr-local/latin-v5-dict.txt /app/runtime-workers/latin-v5-dict.txt && bun entry.ts`,
        context,
        new Map(),
      ),
    ).toEqual([]);
    for (const flag of ["-r", "-R", "-a", "-p"]) {
      expect(
        await checkDockerSource(
          root,
          `${prefix}cp ${flag} helper.ts copied.ts && bun copied.ts`,
          context,
          new Map(),
        ),
      ).toEqual([]);
    }
    for (const flag of ["-r", "-R", "-a"]) {
      expect(
        await checkDockerSource(
          root,
          `${prefix}cp ${flag} folder src && bun src/folder/helper.ts`,
          context,
          new Map(),
        ),
      ).toEqual([]);
    }
    expect(
      await checkDockerSource(
        root,
        `${prefix}cp helper.ts replacement.ts src && bun src/helper.ts`,
        context,
        new Map(),
      ),
    ).toEqual([]);
    expect(
      (
        await checkDockerSource(
          root,
          `${prefix}bun entry.ts && cp replacement.ts helper.ts && bun entry.ts`,
          context,
          new Map(),
        )
      ).join("\n"),
    ).toContain("literal-cp/replacement.ts imports ./absent");
    expect(
      await rejectionOf(
        checkDockerSource(
          root,
          `${prefix}cp missing.ts helper.ts && bun entry.ts`,
          context,
          new Map(),
        ),
      ),
    ).toMatchObject({
      message: expect.stringContaining(
        "cp source is unavailable: /app/missing.ts",
      ),
    });
    for (const command of [
      "cp helper*.ts copied.ts",
      "cp -t src helper.ts",
      "cp --parents helper.ts src",
    ]) {
      expect(
        await rejectionOf(
          checkDockerSource(
            root,
            `${prefix}${command} && bun entry.ts`,
            context,
            new Map(),
          ),
        ),
      ).toMatchObject({
        message: expect.stringContaining(
          "Unsupported source mutation: cp touches",
        ),
      });
    }
  });

  test("checks builds following installs in the same instruction", async () => {
    const entry = put("after-install/entry.ts", 'import "./missing";');
    const context: SourceTree = new Map([["/entry.ts", entry]]);
    for (const install of [
      "bun install --frozen-lockfile",
      "bun i",
      "bun add example",
    ]) {
      const source = `FROM bun AS builder\nWORKDIR /app\nCOPY . .\nRUN ${install} && bun entry.ts`;
      expect(await checkDockerSource(root, source, context, new Map())).toEqual(
        [`${entry} imports ./missing, unavailable in Docker stage`],
      );
    }
  });

  test("declared generated sources enter a stage only after their available producer runs", async () => {
    const generator = GENERATORS.find(({ id }) => id === "capability-runtime");
    if (generator === undefined) {
      throw new Error("Capability runtime generator is missing");
    }
    for (const scenario of [
      "valid",
      "valid-chain",
      "conditional-semicolon",
      "conditional-or",
      "conditional-subshell",
      "conditional-pipe",
      "conditional-background",
      "conditional-earlier-run",
      "missing-command",
      "preload-only",
      "before-producer",
      "missing-producer-input",
      "missing-output",
      "missing-output-import",
    ] as const) {
      const fixtureRoot = mkdtempSync(path.join(root, "generated-stage-"));
      const write = (file: string, source: string) => {
        const target = path.join(fixtureRoot, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, source);
      };
      const producer = generator.write.at(1);
      const output = generator.outputs.at(0);
      if (producer === undefined || output === undefined) {
        throw new Error("Capability generator needs a source entry and output");
      }
      write(
        producer,
        scenario === "missing-producer-input"
          ? 'import "./absent-helper";'
          : "export const generated = true;",
      );
      for (const file of generator.outputs) {
        if (scenario === "missing-output" && file === output) {
          continue;
        }
        write(
          file,
          scenario === "missing-output-import" && file === output
            ? 'import "./absent-output-input";'
            : "export const value = 1;",
        );
      }
      write("entry.ts", `import "./${output.slice(0, -3)}";`);
      const context: SourceTree = new Map([
        [`/${producer}`, producer],
        ["/entry.ts", "entry.ts"],
      ]);
      const run =
        scenario === "preload-only"
          ? `RUN bun --preload ${producer} entry.ts`
          : `RUN ${generator.write.join(" ")}`;
      const build = "RUN bun entry.ts";
      let commands = [run, build];
      if (scenario === "valid-chain") {
        commands = [
          `RUN VALUE="\${PUBLIC_API_URL}" ${generator.write.join(" ")} && bun entry.ts`,
        ];
      } else if (
        scenario === "conditional-semicolon" ||
        scenario === "conditional-or" ||
        scenario === "conditional-subshell" ||
        scenario === "conditional-pipe" ||
        scenario === "conditional-background" ||
        scenario === "conditional-earlier-run"
      ) {
        const command = generator.write.join(" ");
        const conditional = {
          "conditional-semicolon": `RUN false && ${command}; bun entry.ts`,
          "conditional-or": `RUN ${command} || bun entry.ts`,
          "conditional-subshell": `RUN (${command}) && bun entry.ts`,
          "conditional-pipe": `RUN ${command} | bun entry.ts`,
          "conditional-background": `RUN ${command} & bun entry.ts`,
          "conditional-earlier-run": `RUN false && ${command}; true`,
        };
        commands = [
          conditional[scenario],
          ...(scenario === "conditional-earlier-run" ? [build] : []),
        ];
      }
      if (scenario === "before-producer") {
        commands.reverse();
      } else if (scenario === "missing-command") {
        commands.shift();
      }
      const source = [
        "FROM bun AS builder",
        "WORKDIR /app",
        "COPY . .",
        ...commands,
      ].join("\n");
      const problems = await checkDockerSource(
        fixtureRoot,
        source,
        context,
        new Map(),
      );
      if (scenario === "valid" || scenario === "valid-chain") {
        expect(problems).toEqual([]);
      } else {
        const expected = {
          "conditional-semicolon": output.slice(0, -3),
          "conditional-or": output.slice(0, -3),
          "conditional-subshell": output.slice(0, -3),
          "conditional-pipe": output.slice(0, -3),
          "conditional-background": output.slice(0, -3),
          "conditional-earlier-run": output.slice(0, -3),
          "missing-command": output.slice(0, -3),
          "preload-only": output.slice(0, -3),
          "before-producer": output.slice(0, -3),
          "missing-producer-input": "absent-helper",
          "missing-output": output,
          "missing-output-import": "absent-output-input",
        } satisfies Record<typeof scenario, string>;
        expect(problems.join("\n")).toContain(expected[scenario]);
      }
    }
  });

  test("cached generators require their declared inputs and expand output globs", async () => {
    for (const includeInput of [true, false]) {
      const fixtureRoot = mkdtempSync(path.join(root, "cached-generator-"));
      const files = {
        "scripts/prepare-mcp-apps.ts": "export {};",
        "apps/api/package.json": JSON.stringify({
          name: "@stll/api",
          scripts: {
            "generate:mcp-app-contracts":
              "bun scripts/generate-mcp-app-contracts.ts",
          },
        }),
        "apps/api/scripts/generate-mcp-app-contracts.ts": "export {};",
        "packages/mcp-apps/package.json": JSON.stringify({
          name: "@stll/mcp-apps",
          scripts: { build: "bun ../../scripts/prepare-mcp-apps.ts" },
        }),
        "packages/mcp-apps/scripts/build-mcp-apps.ts": "export {};",
        "apps/web/src/fonts.css": "body {}",
        "entry.ts":
          'import "./packages/mcp-apps/src/example/generated/app.html.txt";',
      };
      for (const [file, source] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(fixtureRoot, file)), {
          recursive: true,
        });
        writeFileSync(path.join(fixtureRoot, file), source);
      }
      const generator = GENERATORS.find(({ id }) => id === "mcp-app-bundles");
      if (generator === undefined) {
        panic("Missing MCP app generator");
      }
      for (const pattern of GENERATORS.filter(
        ({ id }) => id === "mcp-app-contracts" || id === generator.id,
      ).flatMap(({ outputs }) => outputs)) {
        const file = pattern.replace("*", "example");
        mkdirSync(path.dirname(path.join(fixtureRoot, file)), {
          recursive: true,
        });
        writeFileSync(path.join(fixtureRoot, file), "{}");
      }
      const context: SourceTree = new Map(
        Object.keys(files).map((file) => [`/${file}`, file]),
      );
      const source = [
        "FROM bun AS builder",
        "WORKDIR /app",
        ...Object.keys(files)
          .filter((file) => includeInput || file !== "apps/web/src/fonts.css")
          .map((file) => `COPY ${file} ${file}`),
        "RUN bun scripts/prepare-mcp-apps.ts",
        "RUN bun entry.ts",
      ].join("\n");
      const problems = await checkDockerSource(
        fixtureRoot,
        source,
        context,
        new Map(),
      );
      if (includeInput) {
        expect(problems).toEqual([]);
      } else {
        expect(problems.join("\n")).toContain(
          "Generator input is unavailable: mcp-app-bundles//apps/web/src/fonts.css",
        );
      }
    }
  });

  test("the API image generates MCP bundles in production", () => {
    const source = readFileSync(
      new URL("../apps/api/Dockerfile", import.meta.url),
      "utf-8",
    );
    const instructions = dockerInstructions(source);
    const builder = instructions.slice(
      instructions.indexOf("FROM deps AS builder"),
    );
    const generation = builder.findIndex((line) =>
      line.includes("bun packages/mcp-apps/scripts/build-mcp-apps.ts"),
    );
    expect(generation).toBeGreaterThan(0);
    expect(builder.slice(0, generation)).toContain("ENV NODE_ENV=production");
    expect(builder.slice(0, generation + 1).join("\n")).not.toMatch(
      /NODE_ENV=development|STELLA_LOCAL_DEV=1/u,
    );
    expect(builder.join("\n")).not.toContain("/app/apps/web/ /app/apps/web/");
    expect(builder.join("\n")).not.toContain("/app/scripts/ /app/scripts/");
  });

  test.each([
    {
      kind: "direct",
      declaration: "",
      form: '[ -n "$TURBO_HASH" ]',
      operator: "||",
      generated: true,
    },
    {
      kind: "static",
      declaration: "ENV TURBO_HASH=x",
      form: '[ -n "$TURBO_HASH" ]',
      operator: "&&",
      generated: true,
    },
    {
      kind: "static",
      declaration: "",
      form: '[ -n "$TURBO_HASH" ]',
      operator: "&&",
      generated: false,
    },
    {
      kind: "static",
      declaration: "ENV TURBO_HASH=x",
      form: '[ -z "$TURBO_HASH" ]',
      operator: "||",
      generated: true,
    },
    {
      kind: "static",
      declaration: "",
      form: '[ -z "$TURBO_HASH" ]',
      operator: "||",
      generated: false,
    },
    {
      kind: "static",
      declaration: "ENV OTHER_FLAG=x",
      form: 'test -n "$OTHER_FLAG"',
      operator: "&&",
      generated: true,
    },
    {
      kind: "static",
      declaration: "ARG TURBO_HASH\nFROM builder AS inherited",
      form: '[ -n "$TURBO_HASH" ]',
      operator: "||",
      generated: false,
    },
    {
      kind: "static",
      declaration: 'ENV TURBO_HASH=""\nFROM builder AS inherited',
      form: '[ -n "$TURBO_HASH" ]',
      operator: "||",
      generated: true,
    },
    {
      kind: "static",
      declaration: "",
      form: '[ -f "$TURBO_HASH" ]',
      operator: "||",
      generated: false,
    },
    {
      kind: "ungrouped",
      declaration: "",
      form: 'test -n "$TURBO_HASH"',
      operator: "||",
      generated: true,
    },
    {
      kind: "inline",
      declaration: "",
      form: '[ -n "$TURBO_HASH" ]',
      operator: "||",
      generated: false,
    },
    ...['[ -n "$TURBO_HASH" ]', 'test -n "$TURBO_HASH"'].flatMap((form) => [
      {
        kind: "static",
        declaration: "",
        form,
        operator: "||",
        generated: true,
      },
      {
        kind: "static",
        declaration: "ARG TURBO_HASH",
        form,
        operator: "||",
        generated: false,
      },
      {
        kind: "static",
        declaration: "ENV TURBO_HASH=x",
        form,
        operator: "||",
        generated: false,
      },
      {
        kind: "static",
        declaration: 'ENV TURBO_HASH=""',
        form,
        operator: "||",
        generated: true,
      },
      {
        kind: "static",
        declaration: 'ENV TURBO_HASH="$VALUE"',
        form,
        operator: "||",
        generated: false,
      },
    ]),
    ...['[ -z "$TURBO_HASH" ]', 'test -z "$TURBO_HASH"'].flatMap((form) => [
      {
        kind: "static",
        declaration: "",
        form,
        operator: "&&",
        generated: true,
      },
      {
        kind: "static",
        declaration: "ARG TURBO_HASH",
        form,
        operator: "&&",
        generated: false,
      },
      {
        kind: "static",
        declaration: "ENV TURBO_HASH=x",
        form,
        operator: "&&",
        generated: false,
      },
      {
        kind: "static",
        declaration: 'ENV TURBO_HASH=""',
        form,
        operator: "&&",
        generated: true,
      },
    ]),
  ])(
    "filtered build scripts require a decidable producer chain: %j",
    async ({ kind, declaration, form, operator, generated }) => {
      const fixtureRoot = mkdtempSync(path.join(root, "generated-filter-"));
      const write = (file: string, source: string) => {
        const target = path.join(fixtureRoot, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, source);
      };
      const outputs = GENERATORS.find(({ id }) => id === "route-tree")?.outputs;
      if (outputs === undefined) {
        panic("Route tree outputs are missing");
      }
      for (const output of outputs) {
        write(output, "export const generated = true;");
      }
      const producer = "apps/web/scripts/generate-route-tree.ts";
      const manifest = "apps/web/package.json";
      const entry = "apps/web/src/entry.ts";
      write(producer, "export const generated = true;");
      let build = `(${form} ${operator} bun run generate:route-tree) && bun src/entry.ts`;
      if (kind === "direct") {
        build = "bun run generate:route-tree && bun src/entry.ts";
      } else if (kind === "ungrouped") {
        build = `${form} ${operator} bun run generate:route-tree && bun src/entry.ts`;
      }
      write(
        manifest,
        JSON.stringify({
          name: "@stll/web",
          scripts: {
            "generate:route-tree": "bun scripts/generate-route-tree.ts",
            build,
          },
        }),
      );
      write(
        entry,
        outputs
          .map(
            (output) =>
              `import ${JSON.stringify(`./${path.basename(output, ".ts")}`)};`,
          )
          .join("\n"),
      );
      const context: SourceTree = new Map(
        [producer, manifest, entry].map((file) => [`/${file}`, file]),
      );
      const source = `FROM bun AS builder\nWORKDIR /app\nCOPY . .\n${declaration}\nRUN ${kind === "inline" ? "TURBO_HASH=x " : ""}bun --filter @stll/web build`;
      const problems = await checkDockerSource(
        fixtureRoot,
        source,
        context,
        new Map(),
      );
      if (generated) {
        expect(problems).toEqual([]);
      } else {
        expect(problems.join("\n")).toContain("routeTree.gen");
      }
      expect(
        (
          await checkDockerSource(
            fixtureRoot,
            source.replace(
              "bun --filter @stll/web build",
              "bun apps/web/src/entry.ts",
            ),
            context,
            new Map(),
          )
        ).join("\n"),
      ).toContain("routeTree.gen");
      for (const command of [
        "bun apps/web/scripts/generate-route-tree.ts --check",
        "bun build apps/web/scripts/generate-route-tree.ts",
      ]) {
        const validationOnly = `FROM bun AS builder\nWORKDIR /app\nCOPY . .\nRUN ${command}\nRUN bun apps/web/src/entry.ts`;
        expect(
          (
            await checkDockerSource(
              fixtureRoot,
              validationOnly,
              context,
              new Map(),
            )
          ).join("\n"),
        ).toContain("routeTree.gen");
      }
    },
  );

  test("later COPY instructions refresh checked entries and alias resolution", async () => {
    for (const laterEntry of ["entry.ts", "other.ts"]) {
      const prefix = `refresh-${laterEntry}`;
      const entry = put(`${prefix}/entry.ts`, 'import "@/dependency";');
      const other = put(`${prefix}/other.ts`, 'import "@/dependency";');
      const dependency = put(
        `${prefix}/dependency.ts`,
        "export const value = 1;",
      );
      const initialConfig = put(
        `${prefix}/initial.json`,
        JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }),
      );
      const replacementConfig = put(
        `${prefix}/replacement.json`,
        JSON.stringify({
          compilerOptions: { paths: { "@/*": ["./missing/*"] } },
        }),
      );
      const context: SourceTree = new Map([
        ["/entry.ts", entry],
        ["/other.ts", other],
        ["/dependency.ts", dependency],
        ["/initial.json", initialConfig],
        ["/replacement.json", replacementConfig],
      ]);
      const beforeCopy =
        "FROM bun AS builder\nWORKDIR /app\nCOPY entry.ts other.ts dependency.ts ./\nCOPY initial.json tsconfig.json\nRUN bun entry.ts";
      expect(
        await checkDockerSource(root, beforeCopy, context, new Map()),
      ).toEqual([]);
      const afterCopy = `${beforeCopy}\nCOPY replacement.json tsconfig.json\nRUN bun ${laterEntry}`;
      expect(
        await checkDockerSource(root, afterCopy, context, new Map()),
      ).toEqual([
        `${laterEntry === "entry.ts" ? entry : other} imports @/dependency, unavailable in Docker stage`,
      ]);
    }
  });

  test("source-run arguments are distinct from Bun options and build entrypoints", async () => {
    const context: SourceTree = new Map([
      ["/app/entry.ts", "entry.ts"],
      ["/app/argument.ts", "argument.ts"],
    ]);
    for (const command of [
      "bun entry.ts --check",
      "bun entry.ts argument.ts --check",
      "bun entry.ts --unknown-script-argument",
    ]) {
      expect(await commandEntries(root, context, command, "/app")).toEqual([
        "/app/entry.ts",
      ]);
    }
    expect(
      await commandEntries(
        root,
        context,
        "bun build entry.ts argument.ts",
        "/app",
      ),
    ).toEqual(["/app/entry.ts", "/app/argument.ts"]);
    expect(
      await rejectionOf(
        commandEntries(root, context, "bun --unknown entry.ts", "/app"),
      ),
    ).toMatchObject({
      message: expect.stringContaining("Unsupported Bun flag: --unknown"),
    });
  });

  test("Bun build format and output flags cannot become source entrypoints", async () => {
    const context = tree(["entry.ts"]);
    for (const command of [
      "bun build entry.ts --format=esm --target=node --outfile=output.ts",
      "bun build --format esm --target node --outdir dist entry.ts",
      "bun build --sourcemap entry.ts",
      "bun build entry.ts --sourcemap",
      "bun build --external excluded.ts --define CONSTANT:1 --root src entry.ts --entry-naming '[name].js' --sourcemap=external --minify-syntax --minify-whitespace --minify-identifiers --splitting",
    ]) {
      expect(await commandEntries(root, context, command, "/app")).toEqual([
        "/app/entry.ts",
      ]);
    }
    for (const command of [
      "bun build --format entry.ts --unknown=true",
      "bun build entry.ts --format",
      "bun build entry.ts --format=",
      "bun build entry.ts --minify=true",
    ]) {
      expect(
        await rejectionOf(commandEntries(root, context, command, "/app")),
      ).toMatchObject({ message: expect.stringMatching(/(?:Bun|source)/u) });
    }
  });

  test("every Bun CLI flag has an explicit arity and source-effect decision", async () => {
    for (const mode of ["build", "run"] as const) {
      const help = Bun.spawnSync([process.execPath, mode, "--help"]);
      expect(help.exitCode).toBe(0);
      const supported = new Set(Object.keys(BUN_FLAGS[mode]));
      const flags = [
        ...help.stdout
          .toString()
          .matchAll(/^\s+(?:(-[A-Za-z]),?\s+)?(--[\w.-]+)(=<val>)?/gmu),
      ];
      expect(flags.length).toBeGreaterThan(50);
      for (const [, short, long] of flags) {
        if (long === undefined) {
          panic("Bun help flag capture is missing");
        }
        expect(supported, `${mode}/${long}`).toContain(long);
        if (short !== undefined) {
          expect(supported, `${mode}/${short}`).toContain(short);
        }
      }
      const context = tree(["entry.ts", "preload.ts"]);
      for (const [flag, policy] of Object.entries(BUN_FLAGS[mode])) {
        if (policy === "workspace") {
          expect(
            await rejectionOf(
              commandEntries(
                root,
                context,
                `bun ${mode} ${flag} unknown entry.ts`,
                "/app",
              ),
            ),
          ).toMatchObject({
            message: expect.stringContaining(
              "Filtered workspace is unavailable",
            ),
          });
          continue;
        }
        if (policy === "unsupported") {
          expect(
            await rejectionOf(
              commandEntries(
                root,
                context,
                `bun ${mode} ${flag} value.ts entry.ts`,
                "/app",
              ),
            ),
          ).toMatchObject({
            message: expect.stringContaining("Unsupported Bun flag semantics"),
          });
          continue;
        }
        for (const spelling of ["separate", "equals"]) {
          let value = "value.ts";
          if (policy === "preload") {
            value = "preload.ts";
          } else if (policy === "cwd") {
            value = "/app";
          }
          let argument = flag;
          if (policy !== "switch" && policy !== "optional-value") {
            argument =
              spelling === "equals" ? `${flag}=${value}` : `${flag} ${value}`;
          }
          expect(
            await commandEntries(
              root,
              context,
              `bun ${mode} ${argument} entry.ts`,
              "/app",
            ),
            `${mode}/${argument}`,
          ).toEqual(
            policy === "preload"
              ? ["/app/preload.ts", "/app/entry.ts"]
              : ["/app/entry.ts"],
          );
        }
      }
    }
  });

  test("Bun preloads enter the stage closure and cwd changes source resolution", async () => {
    const entry = put("flags/entry.ts", "export const value = 1;");
    const preload = put("flags/preload.ts", "export const preloaded = 1;");
    const context: SourceTree = new Map([
      [`/${entry}`, entry],
      [`/${preload}`, preload],
    ]);
    const source =
      "FROM bun\nWORKDIR /app\nCOPY flags/entry.ts flags/entry.ts\nRUN bun run --cwd /app/flags --preload preload.ts entry.ts";
    expect(
      (await checkDockerSource(root, source, context, new Map())).join("\n"),
    ).toContain("preload.ts");
    expect(
      await rejectionOf(
        commandEntries(
          root,
          context,
          "bun run --tsconfig-override config.json flags/entry.ts",
          "/app",
        ),
      ),
    ).toMatchObject({
      message: expect.stringContaining("Unsupported Bun flag semantics"),
    });
  });

  test("late source-resolution flags fail closed instead of reusing an earlier preload path", async () => {
    const context = tree(["preload.ts", "entry.ts"]);
    for (const flag of ["--cwd=/other", "--filter=@stll/other"]) {
      expect(
        await rejectionOf(
          commandEntries(
            root,
            context,
            `bun run --preload preload.ts ${flag} entry.ts`,
            "/app",
          ),
        ),
      ).toMatchObject({
        message: expect.stringContaining("after a source entry"),
      });
    }
  });

  test("Bun runtime options preserve explicit and filtered package scripts", async () => {
    const manifest = put(
      "flagged/package.json",
      JSON.stringify({
        name: "@stll/flagged",
        scripts: { generate: "bun entry.ts" },
      }),
    );
    const entry = put("flagged/entry.ts", "export const value = 1;");
    const context = tree([manifest, entry]);
    for (const command of [
      "bun --cwd=/app/flagged run --silent generate",
      "bun run --cwd /app/flagged generate",
      "bun --filter=@stll/flagged generate",
      "bun run -F @stll/flagged generate",
    ]) {
      expect(await commandEntries(root, context, command, "/app")).toEqual([
        "/app/flagged/entry.ts",
      ]);
    }
  });

  test("the bootstrap metadata expression requires its exact stage input", async () => {
    const context: SourceTree = new Map([
      ["/app/package.json", "package.json"],
    ]);
    for (const flag of ["-p", "--print"]) {
      const command = `bun ${flag} 'require("./package.json").devDependencies.turbo'`;
      expect(await commandEntries(root, context, command, "/app")).toEqual([]);
      expect(
        await rejectionOf(commandEntries(root, new Map(), command, "/app")),
      ).toMatchObject({
        message: expect.stringContaining("Bun metadata input is unavailable"),
      });
    }
    expect(
      await rejectionOf(
        commandEntries(
          root,
          context,
          `bun -p 'require("./missing.ts")'`,
          "/app",
        ),
      ),
    ).toMatchObject({
      message: expect.stringContaining("Unsupported Bun flag semantics"),
    });
  });

  test("remote native archives never manufacture copied or generated source modules", async () => {
    const entry = put("native-add/entry.ts", 'import "./missing";');
    const context: SourceTree = new Map([["/entry.ts", entry]]);
    const checksum = "a".repeat(64);
    const prefix = `FROM bun\nWORKDIR /app\nCOPY entry.ts .\nADD --checksum=sha256:${checksum} https://example.invalid/native.tar /native.tar`;
    expect(await checkDockerSource(root, prefix, context, new Map())).toEqual(
      [],
    );
    expect(
      await rejectionOf(
        checkDockerSource(
          root,
          `${prefix}\nRUN tar -xf /native.tar -C /app && bun entry.ts`,
          context,
          new Map(),
        ),
      ),
    ).toMatchObject({
      message: expect.stringContaining(
        "Unsupported source mutation: tar touches /app",
      ),
    });
    for (const target of ["/app", "/app/"]) {
      expect(
        await checkDockerSource(
          root,
          `FROM bun\nWORKDIR /app\nCOPY entry.ts .\nADD https://example.invalid/native.tar ${target}`,
          context,
          new Map(),
        ),
      ).toEqual([]);
    }
    for (const add of [
      "ADD local.tar /native.tar",
      "ADD https://example.invalid/entry.ts /app/entry.ts",
      "ADD https://example.invalid/native.tar /app/package.json",
      "ADD --unknown=yes https://example.invalid/native.tar /native.tar",
    ]) {
      expect(
        await rejectionOf(
          checkDockerSource(root, `FROM bun\n${add}`, context, new Map()),
        ),
      ).toMatchObject({
        message: expect.stringContaining("Unsupported source instruction"),
      });
    }
  });

  test.each([
    { rootIgnore: "entry.ts", specificIgnore: "", available: true },
    { rootIgnore: "", specificIgnore: "entry.ts", available: false },
    { rootIgnore: "entry.ts", specificIgnore: undefined, available: false },
    { rootIgnore: "", specificIgnore: undefined, available: true },
  ])("Dockerfile ignore rules replace the root rules: %j", async (fixture) => {
    const fixtureRoot = mkdtempSync(path.join(root, "specific-ignore-"));
    writeFileSync(path.join(fixtureRoot, ".dockerignore"), fixture.rootIgnore);
    writeFileSync(
      path.join(fixtureRoot, "entry.ts"),
      "export const value = 1;",
    );
    writeFileSync(
      path.join(fixtureRoot, "Dockerfile"),
      "FROM bun\nWORKDIR /app\nCOPY . .\nRUN bun entry.ts",
    );
    if (fixture.specificIgnore !== undefined) {
      writeFileSync(
        path.join(fixtureRoot, "Dockerfile.dockerignore"),
        fixture.specificIgnore,
      );
    }
    for (const args of [
      ["init", "--quiet"],
      ["add", "."],
    ]) {
      expect(
        Bun.spawnSync(["git", ...args], { cwd: fixtureRoot }).exitCode,
      ).toBe(0);
    }
    expect(await checkRepositoryDockerSources(fixtureRoot)).toEqual(
      fixture.available
        ? []
        : ["Dockerfile: Entry is unavailable: /app/entry.ts"],
    );
  });

  // Measured p95: 17.6 s; this must hydrate and inspect every tracked Dockerfile.
  test("every tracked Dockerfile passes the full hydrated repository check", async () => {
    expect(
      await checkRepositoryDockerSources(path.resolve(import.meta.dir, "..")),
    ).toEqual([]);
  }, 40_000);

  test("runs after source hydration in the installed light job with a fixed total budget", () => {
    // Pooled checks are steps of their job; see scripts/workflow-steps.ts.
    const steps = v.parse(
      v.array(
        v.looseObject({
          name: v.optional(v.string()),
          run: v.optional(v.string()),
          if: v.optional(v.string()),
          "timeout-minutes": v.optional(v.number()),
        }),
      ),
      workflowJobSteps(
        Bun.YAML.parse(
          readFileSync(
            new URL("../.github/workflows/ci.yml", import.meta.url),
            "utf-8",
          ),
        ),
        "ci-checks-rest",
      ),
    );
    const restore = steps.findIndex((step) =>
      step.run?.includes("ci-generated-sources.ts restore"),
    );
    const guard = steps.findIndex(
      (step) => step.name === "Check Docker source closure",
    );
    expect(restore).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(restore);
    expect(steps[guard]?.if).toContain("steps.install.outcome == 'success'");
    expect(steps[guard]?.if).toContain("package_checks_required == 'true'");
    expect(steps[guard]?.["timeout-minutes"]).toBe(1);
    expect(steps[guard]?.run).toBe(
      "timeout 30s bun test scripts/docker-source-closure.test.ts",
    );
  });

  test("rejects the omitted root helper even when it exists in the checkout", async () => {
    const helper = "packages/scripts/src/prepared-generated-sources.ts";
    const actual = readFileSync(
      new URL(`../${helper}`, import.meta.url),
      "utf-8",
    );
    put(
      helper,
      actual.replace(
        '"./generated-file-inventory"',
        '"../../../scripts/generated-files"',
      ),
    );
    put("scripts/generated-files.ts", "export const CI_GENERATED_FILES = [];");
    const identity = put(
      "packages/scripts/src/generated-input-identity.ts",
      "export const generatedInputGit = () => ''; export const generatedInputTreeHash = () => '';",
    );
    const available = tree([helper, identity]);
    expect(
      await sourceClosureProblems(root, available, [`/app/${helper}`]),
    ).toEqual([
      `${helper} imports ../../../scripts/generated-files, unavailable in Docker stage`,
    ]);
    available.set(
      "/app/scripts/generated-files.ts",
      "scripts/generated-files.ts",
    );
    expect(
      await sourceClosureProblems(root, available, [`/app/${helper}`]),
    ).toEqual([]);
  });

  test("follows transitive and dynamic literal imports with cycles", async () => {
    const files = [
      put("cycle/a.ts", 'import "./b"; import("./dynamic");'),
      put("cycle/b.ts", 'export * from "./a"; import "./missing.json";'),
      put("cycle/dynamic.ts", 'import "./b";'),
    ];
    expect(
      await sourceClosureProblems(root, tree(files), ["/app/cycle/a.ts"]),
    ).toEqual([
      "cycle/b.ts imports ./missing.json, unavailable in Docker stage",
    ]);
  });

  test("removing any discovered source leaf makes the closure fail", async () => {
    const leaves = Array.from({ length: 8 }, (_, index) =>
      put(`enumerated/leaf-${index}.ts`, "export const value = 1;"),
    );
    const entry = put(
      "enumerated/entry.ts",
      leaves.map((_, index) => `export * from "./leaf-${index}";`).join("\n"),
    );
    const sources = tree([entry, ...leaves]);
    expect(
      await sourceClosureProblems(root, sources, ["/app/enumerated/entry.ts"]),
    ).toEqual([]);
    for (const leaf of leaves) {
      const missing = new Map(sources);
      missing.delete(`/app/${leaf}`);
      expect(
        await sourceClosureProblems(root, missing, [
          "/app/enumerated/entry.ts",
        ]),
      ).toHaveLength(1);
    }
  });

  test("only value edges from imports and named exports enter a runtime closure", async () => {
    const file = put(
      "types.ts",
      'import type { A } from "./absent"; import { type B } from "./absent"; export type { C } from "./absent"; export { type D, type E } from "./absent";',
    );
    expect(
      await sourceClosureProblems(root, tree([file]), ["/app/types.ts"]),
    ).toEqual([]);
    for (const [index, statement] of [
      'export { type A, value } from "./absent";',
      'export {} from "./absent";',
      'import { type A, value } from "./absent";',
    ].entries()) {
      const entry = put(`mixed-types-${index}.ts`, statement);
      expect(
        await sourceClosureProblems(root, tree([entry]), [`/app/${entry}`]),
      ).toEqual([`${entry} imports ./absent, unavailable in Docker stage`]);
    }
  });

  test("declarations cannot satisfy a runtime source import", async () => {
    const config = put(
      "apps/declarations/tsconfig.json",
      JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
    );
    const declaration = put(
      "apps/declarations/src/declared.d.ts",
      "export declare const value: number;",
    );
    for (const [index, specifier] of [
      "./declared",
      "./declared.js",
      "@/declared",
    ].entries()) {
      const entry = put(
        `apps/declarations/src/entry-${index}.ts`,
        `import "${specifier}";`,
      );
      expect(
        await sourceClosureProblems(root, tree([config, declaration, entry]), [
          `/app/${entry}`,
        ]),
      ).toEqual([`${entry} imports ${specifier}, unavailable in Docker stage`]);
    }
  });

  test("resolves dotted module basenames only from stage sources", async () => {
    const config = put(
      "apps/dotted/tsconfig.json",
      JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
    );
    for (const suffix of [
      "logic",
      "gen",
      "generated",
      "query",
      "constants",
      "custom.name",
    ]) {
      const dependency = put(
        `apps/dotted/src/value.${suffix}.ts`,
        "export const value = 1;",
      );
      for (const prefix of ["./", "@/"]) {
        const specifier = `${prefix}value.${suffix}`;
        const entry = put(
          `apps/dotted/src/entry-${suffix}-${prefix === "./" ? "relative" : "alias"}.ts`,
          `import "${specifier}";`,
        );
        expect(
          await sourceClosureProblems(root, tree([config, entry, dependency]), [
            `/app/${entry}`,
          ]),
        ).toEqual([]);
        expect(
          await sourceClosureProblems(root, tree([config, entry]), [
            `/app/${entry}`,
          ]),
        ).toEqual([
          `${entry} imports ${specifier}, unavailable in Docker stage`,
        ]);
      }
    }
  });

  test("Bun runtime and bundling tolerate a missing inherited tsconfig", async () => {
    const directory = "missing-inherited-config";
    const config = put(
      `${directory}/tsconfig.json`,
      JSON.stringify({
        extends: "./absent-tooling.json",
        compilerOptions: { paths: { "~/*": ["./src/*"] } },
      }),
    );
    const target = put(`${directory}/src/value.ts`, "export const value = 42;");
    const entry = put(
      `${directory}/entry.ts`,
      'import { value } from "~/value"; console.log(value);',
    );
    const cwd = path.join(root, directory);
    for (const args of [
      ["run", "entry.ts"],
      ["build", "entry.ts", "--target=bun", "--outdir=dist"],
    ]) {
      const result = Bun.spawnSync([process.execPath, ...args], { cwd });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    }
    expect(
      await sourceClosureProblems(root, tree([config, entry, target]), [
        `/app/${entry}`,
      ]),
    ).toEqual([]);
    expect(
      await sourceClosureProblems(root, tree([config, entry]), [
        `/app/${entry}`,
      ]),
    ).toEqual([`${entry} imports ~/value, unavailable in Docker stage`]);
  });

  test("every tracked tsconfig alias and custom alias requires its stage source", async () => {
    const repositoryRoot = path.resolve(import.meta.dir, "..");
    const listed = Bun.spawnSync(
      ["git", "ls-files", "-z", "--", "*tsconfig*.json"],
      { cwd: repositoryRoot },
    );
    expect(listed.exitCode, listed.stderr.toString()).toBe(0);
    const configurations = listed.stdout.toString().split("\0").filter(Boolean);
    expect(configurations.length).toBeGreaterThan(0);
    const patterns = new Set<string>();
    for (const configuration of configurations) {
      const api = new API({ cwd: repositoryRoot });
      const parsed = await (async () => {
        try {
          return await api.readConfigFile(
            path.join(repositoryRoot, configuration),
          );
        } finally {
          await api.close();
        }
      })();
      expect(parsed.error, configuration).toBeUndefined();
      const config = v.parse(
        v.looseObject({
          compilerOptions: v.optional(
            v.looseObject({
              paths: v.optional(v.record(v.string(), v.array(v.string()))),
            }),
          ),
        }),
        parsed.config,
      );
      for (const pattern of Object.keys(config.compilerOptions?.paths ?? {})) {
        patterns.add(pattern);
      }
    }
    expect(patterns.size).toBeGreaterThan(0);
    patterns.add("~/*");
    patterns.add("custom-*-suffix");
    for (const [index, pattern] of [...patterns].entries()) {
      const directory = `apps/alias-census-${index}`;
      const specifier = pattern.replace("*", "nested/value");
      const config = put(
        `${directory}/tsconfig.json`,
        JSON.stringify({
          compilerOptions: { paths: { [pattern]: ["./target.ts"] } },
        }),
      );
      const entry = put(
        `${directory}/entry.ts`,
        `import ${JSON.stringify(specifier)};`,
      );
      const target = put(`${directory}/target.ts`, "export const value = 1;");
      expect(
        await sourceClosureProblems(root, tree([config, entry, target]), [
          `/app/${entry}`,
        ]),
        pattern,
      ).toEqual([]);
      expect(
        await sourceClosureProblems(root, tree([config, entry]), [
          `/app/${entry}`,
        ]),
        pattern,
      ).toEqual([`${entry} imports ${specifier}, unavailable in Docker stage`]);
    }
  });

  test("resolves aliases using only stage sources", async () => {
    const files = [
      put(
        "apps/example/tsconfig.json",
        JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
      ),
      put("apps/example/src/a.ts", 'import "@/b";'),
      put("apps/example/src/b.ts", "export const b = 1;"),
    ];
    expect(
      await sourceClosureProblems(root, tree(files), [
        "/app/apps/example/src/a.ts",
      ]),
    ).toEqual([]);
    expect(
      await sourceClosureProblems(root, tree(files.slice(0, 2)), [
        "/app/apps/example/src/a.ts",
      ]),
    ).toHaveLength(1);
  });

  test("only the most specific alias supplies targets regardless of declaration order", async () => {
    for (const exact of [false, true]) {
      for (const reversed of [false, true]) {
        const directory = `apps/alias-priority-${exact}-${reversed}`;
        const bindings = [
          ["@/*", ["./broad/*"]],
          [
            exact ? "@/special/value" : "@/special/*",
            [exact ? "./specific/value.ts" : "./specific/*"],
          ],
        ];
        if (reversed) {
          bindings.reverse();
        }
        const config = put(
          `${directory}/tsconfig.json`,
          JSON.stringify({
            compilerOptions: { paths: Object.fromEntries(bindings) },
          }),
        );
        const entry = put(`${directory}/entry.ts`, 'import "@/special/value";');
        const broad = put(
          `${directory}/broad/special/value.ts`,
          "export const value = 1;",
        );
        const specific = put(
          `${directory}/specific/value.ts`,
          "export const value = 2;",
        );
        const sources = tree([config, entry, broad]);
        expect(
          await sourceClosureProblems(root, sources, [`/app/${entry}`]),
        ).toEqual([
          `${entry} imports @/special/value, unavailable in Docker stage`,
        ]);
        sources.set(`/app/${specific}`, specific);
        expect(
          await sourceClosureProblems(root, sources, [`/app/${entry}`]),
        ).toEqual([]);
      }
    }
    const config = put(
      "apps/alias-fallback/tsconfig.json",
      JSON.stringify({
        compilerOptions: { paths: { "@/*": ["./absent/*", "./present/*"] } },
      }),
    );
    const entry = put("apps/alias-fallback/entry.ts", 'import "@/value";');
    const fallback = put(
      "apps/alias-fallback/present/value.ts",
      "export const value = 1;",
    );
    expect(
      await sourceClosureProblems(root, tree([config, entry, fallback]), [
        `/app/${entry}`,
      ]),
    ).toEqual([]);
  });

  test("retains the declaration directory of inherited aliases", async () => {
    const files = [
      put(
        "apps/inherited/tsconfig.json",
        JSON.stringify({
          compilerOptions: { paths: { "@/app/*": ["./src/*"] } },
        }),
      ),
      put(
        "apps/inherited/scripts/tsconfig.json",
        JSON.stringify({ extends: "../tsconfig.json" }),
      ),
      put("apps/inherited/scripts/entry.ts", 'import "@/app/value";'),
      put("apps/inherited/src/value.ts", "export const value = 1;"),
    ];
    expect(
      await sourceClosureProblems(root, tree(files), [
        "/app/apps/inherited/scripts/entry.ts",
      ]),
    ).toEqual([]);
  });

  test("checks Vite worker sources and imported assets", async () => {
    const files = [
      put(
        "worker-entry.ts",
        'import "./worker?worker&url"; import "./data.txt?raw";',
      ),
      put("worker.ts", 'import "./missing";'),
      put("data.txt", "asset"),
    ];
    expect(
      await sourceClosureProblems(root, tree(files), ["/app/worker-entry.ts"]),
    ).toEqual(["worker.ts imports ./missing, unavailable in Docker stage"]);
  });

  test("resolves a workspace export without checkout symlinks", async () => {
    const files = [
      put(
        "packages/example/package.json",
        JSON.stringify({
          name: "@stll/example",
          exports: { ".": "./src/index.ts" },
        }),
      ),
      put("packages/example/src/index.ts", 'export * from "./absent";'),
      put("workspace-entry.ts", 'import "@stll/example";'),
    ];
    expect(
      await sourceClosureProblems(root, tree(files), [
        "/app/workspace-entry.ts",
      ]),
    ).toEqual([
      "packages/example/src/index.ts imports ./absent, unavailable in Docker stage",
    ]);
  });

  test("resolves a workspace asset export only when the stage holds it", async () => {
    const files = [
      put(
        "packages/asset-example/package.json",
        JSON.stringify({
          name: "@stll/asset-example",
          exports: {
            "./present.css": "./src/present.css",
            "./absent.css": "./src/absent.css",
          },
        }),
      ),
      put("packages/asset-example/src/present.css", "a {}"),
      put(
        "asset-entry.ts",
        'import "@stll/asset-example/present.css"; import "@stll/asset-example/absent.css";',
      ),
    ];
    expect(
      await sourceClosureProblems(root, tree(files), ["/app/asset-entry.ts"]),
    ).toEqual([
      "asset-entry.ts imports @stll/asset-example/absent.css, unavailable in Docker stage",
    ]);
  });

  test("applies dockerignore to ancestors, recursive globs and ordered exclusions", () => {
    const ignore = "node_modules\n**/dist\n*.md\n!README.md\n**/*.test.ts\n";
    for (const file of [
      "node_modules/x/a.ts",
      "apps/a/dist/index.js",
      "NOTES.md",
      "apps/a/src/a.test.ts",
    ]) {
      expect(inDockerContext(file, ignore)).toBe(false);
    }
    for (const file of [
      "README.md",
      "apps/a/README.md",
      "apps/a/src/index.ts",
    ]) {
      expect(inDockerContext(file, ignore)).toBe(true);
    }
  });

  test("copies directory contents and files into their stage destination", () => {
    const source = tree(["a/index.ts", "a/sub/data.json"]);
    const destination: SourceTree = new Map();
    copySource(source, destination, "/app/a/", "/app/copied/");
    expect([...destination.keys()]).toEqual([
      "/app/copied/index.ts",
      "/app/copied/sub/data.json",
    ]);
    copySource(source, destination, "/app/a/index.ts", "/app/direct/");
    expect(destination.get("/app/direct/index.ts")).toBe("a/index.ts");
    expect(() =>
      copySource(source, destination, "/app/absent", "/app/"),
    ).toThrow("unavailable");
  });

  test("checks a consumer after its actual pruned COPY, not the full context", async () => {
    const entry = put("stage-entry.ts", 'import "./root-helper";');
    const helper = put("root-helper.ts", "export const value = 1;");
    const context: SourceTree = new Map([
      ["/stage-entry.ts", entry],
      ["/root-helper.ts", helper],
    ]);
    const pruned = tree([entry]);
    const dockerfile =
      "FROM bun AS pruner\nWORKDIR /app\nCOPY . .\nRUN turbo prune @stll/example --docker\nFROM bun AS builder\nWORKDIR /app\nCOPY --from=pruner /app/out/full/ .\nRUN bun stage-entry.ts";
    expect(await checkDockerSource(root, dockerfile, context, pruned)).toEqual([
      "stage-entry.ts imports ./root-helper, unavailable in Docker stage",
    ]);
    pruned.set("/app/root-helper.ts", helper);
    expect(await checkDockerSource(root, dockerfile, context, pruned)).toEqual(
      [],
    );
  });

  test("checks every command following prune and preserves source production order", async () => {
    const entry = put("prune-order/entry.ts", 'import "./out/full/value";');
    const value = put("prune-order/value.ts", "export const value = 1;");
    const context: SourceTree = new Map([["/entry.ts", entry]]);
    const pruned: SourceTree = new Map([["/app/value.ts", value]]);
    const base = "FROM bun AS pruner\nWORKDIR /app\nCOPY . .\nRUN ";
    for (const separator of ["&&", ";", "||"]) {
      const prune = "turbo prune @stll/example --docker";
      expect(
        await checkDockerSource(
          root,
          `${base}${prune} ${separator} bun absent.ts`,
          context,
          pruned,
        ),
      ).toEqual(["Entry is unavailable: /app/absent.ts"]);
      expect(
        await checkDockerSource(
          root,
          `${base}${prune} ${separator} bun entry.ts`,
          context,
          pruned,
        ),
      ).toEqual(
        separator === "&&"
          ? []
          : [`${entry} imports ./out/full/value, unavailable in Docker stage`],
      );
      expect(
        await checkDockerSource(
          root,
          `${base}bun entry.ts ${separator} ${prune}`,
          context,
          pruned,
        ),
      ).toEqual([
        `${entry} imports ./out/full/value, unavailable in Docker stage`,
      ]);
      expect(
        await rejectionOf(
          checkDockerSource(
            root,
            `${base}${prune} ${separator} npm unknown`,
            context,
            pruned,
          ),
        ),
      ).toMatchObject({
        message: expect.stringContaining("Unsupported source runner: npm"),
      });
    }
  });

  test("derives actual prune scopes and rejects unrecognized forms", () => {
    const source = readFileSync(
      new URL("../apps/api/Dockerfile", import.meta.url),
      "utf-8",
    );
    expect(dockerPruneScopes(source)).toEqual([
      ["@stll/api", "@stll/collab", "@stll/legal-atlas-runner"],
    ]);
    expect(dockerInstructions("# comment\nRUN bun build \\\n a.ts")).toEqual([
      "RUN bun build   a.ts",
    ]);
    expect(() => dockerPruneScopes("RUN turbo prune $SCOPE --docker")).toThrow(
      "Unsupported",
    );
    expect(() => dockerInstructions("RUN <<EOF\nx\nEOF")).toThrow(
      "Unsupported",
    );
    expect(dockerPruneScopes("run turbo prune @stll/example --docker")).toEqual(
      [["@stll/example"]],
    );
  });

  test("expands the named build script and nested generator", async () => {
    const files = [
      put(
        "apps/commands/package.json",
        JSON.stringify({
          name: "@stll/commands",
          scripts: {
            build:
              "bun run generate && bun build --target=bun --outfile=dist/app.js src/index.ts",
            generate: "bun scripts/generate.ts",
          },
        }),
      ),
    ];
    expect(
      await commandEntries(
        root,
        tree(files),
        "bun --filter @stll/commands build",
        "/app",
      ),
    ).toEqual([
      "/app/apps/commands/scripts/generate.ts",
      "/app/apps/commands/src/index.ts",
    ]);
    expect(
      await commandEntries(
        root,
        tree(files),
        "cd apps/commands && bun src/main.ts",
        "/app",
      ),
    ).toEqual(["/app/apps/commands/src/main.ts"]);
    expect(
      await rejectionOf(
        commandEntries(root, tree(files), "bun $ENTRY", "/app"),
      ),
    ).toMatchObject({ message: expect.stringContaining("Unsupported") });
    expect(
      await commandEntries(
        root,
        tree(files),
        "bun --cwd=elsewhere src/main.ts",
        "/app",
      ),
    ).toEqual(["/app/elsewhere/src/main.ts"]);
    expect(
      (
        await commandEntries(
          root,
          tree(files),
          "bun --filter @stll/commands build && bun root.ts",
          "/app",
        )
      ).at(-1),
    ).toBe("/app/root.ts");
    expect(
      await commandEntries(
        root,
        tree(files),
        "(cd apps/commands && bun src/main.ts) && bun root.ts",
        "/app",
      ),
    ).toEqual(["/app/apps/commands/src/main.ts", "/app/root.ts"]);
  });
});
