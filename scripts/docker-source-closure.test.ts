import { panic } from "better-result";
import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import * as v from "valibot";

import {
  BUN_FLAGS,
  checkRepositoryDockerSources,
  commandEntries,
  checkDockerSource,
  copySource,
  dockerInstructions,
  dockerPruneScopes,
  inDockerContext,
  sourceClosureProblems,
  type SourceTree,
} from "./docker-source-closure";
import { GENERATORS } from "./generated-files";

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
  test("checks the sandbox install and cache commands without hiding source runners", () => {
    const source = readFileSync(
      new URL(
        "../packages/agent-engine/docker/sandbox.Dockerfile",
        import.meta.url,
      ),
      "utf-8",
    );
    expect(checkDockerSource(root, source, new Map(), new Map())).toEqual([]);
    expect(
      checkDockerSource(
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
      expect(() => commandEntries(root, new Map(), command, "/app")).toThrow(
        "Unsupported source runner: npm",
      );
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

  test("continued instructions retain commands across whitespace and blank lines", () => {
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
        expect(checkDockerSource(root, source, new Map(), new Map())).toEqual([
          "Entry is unavailable: /app/absent.ts",
        ]);
      }
    }
  });

  test("source wrappers check their inner reads without splitting quoted arguments", () => {
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
        checkDockerSource(
          root,
          `FROM bun AS builder\nWORKDIR /app\nCOPY entry.ts .\nRUN ${prefix} bun entry.ts`,
          context,
          new Map(),
        ),
      ).toEqual([
        "wrapper/entry.ts imports ./missing, unavailable in Docker stage",
      ]);
      expect(
        commandEntries(
          root,
          tree(["entry.ts"]),
          `${prefix} bun absent.ts`,
          "/app",
        ),
      ).toEqual(["/app/absent.ts"]);
      expect(
        commandEntries(
          root,
          tree(["entry.ts"]),
          `${prefix} bun 'entry with spaces.ts'`,
          "/app",
        ),
      ).toEqual(["/app/entry with spaces.ts"]);
    }
    for (const shell of ["sh", "bash"]) {
      expect(
        checkDockerSource(
          root,
          `FROM bun AS builder\nWORKDIR /app\nCOPY entry.ts .\nRUN ${shell} -c 'bun entry.ts'`,
          context,
          new Map(),
        ),
      ).toEqual([
        "wrapper/entry.ts imports ./missing, unavailable in Docker stage",
      ]);
      expect(
        commandEntries(
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
      expect(() =>
        commandEntries(root, tree(["entry.ts"]), command, "/app"),
      ).toThrow(/Unsupported source wrapper/u);
    }
  });

  test("external COPY assets are opaque and cannot supply source inventory", () => {
    for (const from of ["oven/bun:1", "unmodelled", "0"]) {
      const source = `FROM bun AS builder\nWORKDIR /app\nCOPY --from=${from} /usr/bin/bun /usr/bin/bun`;
      expect(checkDockerSource(root, source, new Map(), new Map())).toEqual([]);
      expect(
        checkDockerSource(
          root,
          `${source}\nRUN bun entry.ts`,
          new Map(),
          new Map(),
        ),
      ).toEqual(["Entry is unavailable: /app/entry.ts"]);
    }
    expect(() =>
      checkDockerSource(
        root,
        "FROM bun AS builder\nCOPY --from=pruner /app/src /app/src",
        new Map(),
        new Map(),
      ),
    ).toThrow("Unknown COPY stage: pruner");
  });

  test("copies multiple source contents into one destination", () => {
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
    expect(checkDockerSource(root, dockerfile, context, new Map())).toEqual([]);
    expect(() =>
      checkDockerSource(
        root,
        dockerfile.replace("./", "destination"),
        context,
        new Map(),
      ),
    ).toThrow("Multiple COPY sources require a directory destination");
    expect(
      checkDockerSource(
        root,
        dockerfile.replace("bun entry.ts", "bun apps/entry.ts"),
        context,
        new Map(),
      ),
    ).toEqual(["Entry is unavailable: /app/apps/entry.ts"]);
  });

  test("COPY and ADD infer existing destination directories for single and multiple files", () => {
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
        expect(checkDockerSource(root, dockerfile, context, new Map())).toEqual(
          [],
        );
      }
      expect(() =>
        checkDockerSource(
          root,
          `FROM bun\nWORKDIR /app\n${operation} helper.ts second.ts /app/not-a-directory`,
          context,
          new Map(),
        ),
      ).toThrow(
        `Multiple ${operation} sources require a directory destination`,
      );
      expect(() =>
        checkDockerSource(
          root,
          `FROM bun\nWORKDIR /app\n${operation} helper.ts /app/not-a-directory\n${operation} helper.ts second.ts /app/not-a-directory`,
          context,
          new Map(),
        ),
      ).toThrow(
        `Multiple ${operation} sources require a directory destination`,
      );
      expect(
        checkDockerSource(
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

  test("cached import edges retain content and stage inventory boundaries", () => {
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
    expect(sourceClosureProblems(root, complete, ["/app/entry.ts"])).toEqual(
      [],
    );
    expect(sourceClosureProblems(root, omitted, ["/app/entry.ts"])).toEqual([
      "import-cache/first.ts imports ./first-dependency, unavailable in Docker stage",
    ]);
    expect(sourceClosureProblems(root, replaced, ["/app/entry.ts"])).toEqual([
      "import-cache/second.ts imports ./second-dependency, unavailable in Docker stage",
    ]);
  });

  test("conditional workspace exports reject unmodeled custom Bun conditions", () => {
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
      sourceClosureProblems(root, inventory, ["/app/conditions-entry.ts"]),
    ).toEqual([]);
    for (const mode of ["run", "build"]) {
      for (const flag of [
        "--conditions=production",
        "--conditions production",
        "-C production",
      ]) {
        expect(() =>
          commandEntries(
            root,
            inventory,
            `bun ${mode} ${flag} conditions-entry.ts`,
            "/app",
          ),
        ).toThrow("Unsupported Bun flag semantics");
      }
    }
  });

  test("source mutations remove inventory and unknown writers fail closed before runners", () => {
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
        checkDockerSource(root, prefix + command, context, new Map()).join(
          "\n",
        ),
      ).toMatch(/unavailable in Docker stage|Entry is unavailable/u);
    }
    expect(
      checkDockerSource(
        root,
        `${prefix}mv helper.ts moved.ts && bun moved.ts`,
        context,
        new Map(),
      ),
    ).toEqual([]);
    expect(
      checkDockerSource(
        root,
        `${prefix}false && mv helper.ts moved.ts; bun moved.ts`,
        context,
        new Map(),
      ),
    ).toEqual(["Entry is unavailable: /app/moved.ts"]);
    expect(
      checkDockerSource(
        root,
        `${prefix}cp helper.ts copied.ts && bun copied.ts`,
        context,
        new Map(),
      ),
    ).toEqual([]);
    expect(
      checkDockerSource(
        root,
        `${prefix}false && cp helper.ts copied.ts; bun copied.ts`,
        context,
        new Map(),
      ),
    ).toEqual(["Entry is unavailable: /app/copied.ts"]);
    expect(() =>
      checkDockerSource(
        root,
        `${prefix}cp absent.ts helper.ts && bun entry.ts`,
        context,
        new Map(),
      ),
    ).toThrow("cp source is unavailable: /app/absent.ts");
    expect(() =>
      checkDockerSource(
        root,
        `${prefix}cp --unknown helper.ts copied.ts && bun entry.ts`,
        context,
        new Map(),
      ),
    ).toThrow("Unsupported source mutation: cp touches /app/helper.ts");
    for (const command of [
      "sed -i helper.ts && bun entry.ts",
      "sed -i helper.ts\nRUN bun entry.ts",
    ]) {
      expect(() =>
        checkDockerSource(root, prefix + command, context, new Map()),
      ).toThrow("Unsupported source mutation: sed touches /app/helper.ts");
    }
    expect(
      checkDockerSource(
        root,
        `${
          prefix
        }rm -rf /var/lib/apt/lists/* /root/.bun/install/cache && bun entry.ts`,
        context,
        new Map(),
      ),
    ).toEqual([]);
  });

  test("literal cp supports source reads, overwrites, directories and preservation flags", () => {
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
      checkDockerSource(
        root,
        `${prefix}cp apps/api/src/lib/ocr-local/latin-v5-dict.txt /app/runtime-workers/latin-v5-dict.txt && bun entry.ts`,
        context,
        new Map(),
      ),
    ).toEqual([]);
    for (const flag of ["-r", "-R", "-a", "-p"]) {
      expect(
        checkDockerSource(
          root,
          `${prefix}cp ${flag} helper.ts copied.ts && bun copied.ts`,
          context,
          new Map(),
        ),
      ).toEqual([]);
    }
    for (const flag of ["-r", "-R", "-a"]) {
      expect(
        checkDockerSource(
          root,
          `${prefix}cp ${flag} folder src && bun src/folder/helper.ts`,
          context,
          new Map(),
        ),
      ).toEqual([]);
    }
    expect(
      checkDockerSource(
        root,
        `${prefix}cp helper.ts replacement.ts src && bun src/helper.ts`,
        context,
        new Map(),
      ),
    ).toEqual([]);
    expect(
      checkDockerSource(
        root,
        `${prefix}bun entry.ts && cp replacement.ts helper.ts && bun entry.ts`,
        context,
        new Map(),
      ).join("\n"),
    ).toContain("literal-cp/replacement.ts imports ./absent");
    expect(() =>
      checkDockerSource(
        root,
        `${prefix}cp missing.ts helper.ts && bun entry.ts`,
        context,
        new Map(),
      ),
    ).toThrow("cp source is unavailable: /app/missing.ts");
    for (const command of [
      "cp helper*.ts copied.ts",
      "cp -t src helper.ts",
      "cp --parents helper.ts src",
    ]) {
      expect(() =>
        checkDockerSource(
          root,
          `${prefix}${command} && bun entry.ts`,
          context,
          new Map(),
        ),
      ).toThrow("Unsupported source mutation: cp touches");
    }
  });

  test("checks builds following installs in the same instruction", () => {
    const entry = put("after-install/entry.ts", 'import "./missing";');
    const context: SourceTree = new Map([["/entry.ts", entry]]);
    for (const install of [
      "bun install --frozen-lockfile",
      "bun i",
      "bun add example",
    ]) {
      const source = `FROM bun AS builder\nWORKDIR /app\nCOPY . .\nRUN ${install} && bun entry.ts`;
      expect(checkDockerSource(root, source, context, new Map())).toEqual([
        `${entry} imports ./missing, unavailable in Docker stage`,
      ]);
    }
  });

  test("declared generated sources enter a stage only after their available producer runs", () => {
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
      const problems = checkDockerSource(
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
    ({ kind, declaration, form, operator, generated }) => {
      const fixtureRoot = mkdtempSync(path.join(root, "generated-filter-"));
      const write = (file: string, source: string) => {
        const target = path.join(fixtureRoot, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, source);
      };
      const output = GENERATORS.find(
        ({ id }) => id === "route-tree",
      )?.outputs.at(0);
      if (output === undefined) {
        throw new Error("Route tree output is missing");
      }
      write(output, "export const routeTree = {};");
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
      write(entry, 'import "./routeTree.gen";');
      const context: SourceTree = new Map(
        [producer, manifest, entry].map((file) => [`/${file}`, file]),
      );
      const source = `FROM bun AS builder\nWORKDIR /app\nCOPY . .\n${declaration}\nRUN ${kind === "inline" ? "TURBO_HASH=x " : ""}bun --filter @stll/web build`;
      const problems = checkDockerSource(
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
        checkDockerSource(
          fixtureRoot,
          source.replace(
            "bun --filter @stll/web build",
            "bun apps/web/src/entry.ts",
          ),
          context,
          new Map(),
        ).join("\n"),
      ).toContain("routeTree.gen");
      for (const command of [
        "bun apps/web/scripts/generate-route-tree.ts --check",
        "bun build apps/web/scripts/generate-route-tree.ts",
      ]) {
        const validationOnly = `FROM bun AS builder\nWORKDIR /app\nCOPY . .\nRUN ${command}\nRUN bun apps/web/src/entry.ts`;
        expect(
          checkDockerSource(
            fixtureRoot,
            validationOnly,
            context,
            new Map(),
          ).join("\n"),
        ).toContain("routeTree.gen");
      }
    },
  );

  test("later COPY instructions refresh checked entries and alias resolution", () => {
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
      expect(checkDockerSource(root, beforeCopy, context, new Map())).toEqual(
        [],
      );
      const afterCopy = `${beforeCopy}\nCOPY replacement.json tsconfig.json\nRUN bun ${laterEntry}`;
      expect(checkDockerSource(root, afterCopy, context, new Map())).toEqual([
        `${laterEntry === "entry.ts" ? entry : other} imports @/dependency, unavailable in Docker stage`,
      ]);
    }
  });

  test("source-run arguments are distinct from Bun options and build entrypoints", () => {
    const context: SourceTree = new Map([
      ["/app/entry.ts", "entry.ts"],
      ["/app/argument.ts", "argument.ts"],
    ]);
    for (const command of [
      "bun entry.ts --check",
      "bun entry.ts argument.ts --check",
      "bun entry.ts --unknown-script-argument",
    ]) {
      expect(commandEntries(root, context, command, "/app")).toEqual([
        "/app/entry.ts",
      ]);
    }
    expect(
      commandEntries(root, context, "bun build entry.ts argument.ts", "/app"),
    ).toEqual(["/app/entry.ts", "/app/argument.ts"]);
    expect(() =>
      commandEntries(root, context, "bun --unknown entry.ts", "/app"),
    ).toThrow("Unsupported Bun flag: --unknown");
  });

  test("Bun build format and output flags cannot become source entrypoints", () => {
    const context = tree(["entry.ts"]);
    for (const command of [
      "bun build entry.ts --format=esm --target=node --outfile=output.ts",
      "bun build --format esm --target node --outdir dist entry.ts",
      "bun build --sourcemap entry.ts",
      "bun build entry.ts --sourcemap",
      "bun build --external excluded.ts --define CONSTANT:1 --root src entry.ts --entry-naming '[name].js' --sourcemap=external --minify-syntax --minify-whitespace --minify-identifiers --splitting",
    ]) {
      expect(commandEntries(root, context, command, "/app")).toEqual([
        "/app/entry.ts",
      ]);
    }
    for (const command of [
      "bun build --format entry.ts --unknown=true",
      "bun build entry.ts --format",
      "bun build entry.ts --format=",
      "bun build entry.ts --minify=true",
    ]) {
      expect(() => commandEntries(root, context, command, "/app")).toThrow(
        /(?:Bun|source)/u,
      );
    }
  });

  test("every Bun CLI flag has an explicit arity and source-effect decision", () => {
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
          expect(() =>
            commandEntries(
              root,
              context,
              `bun ${mode} ${flag} unknown entry.ts`,
              "/app",
            ),
          ).toThrow("Filtered workspace is unavailable");
          continue;
        }
        if (policy === "unsupported") {
          expect(() =>
            commandEntries(
              root,
              context,
              `bun ${mode} ${flag} value.ts entry.ts`,
              "/app",
            ),
          ).toThrow("Unsupported Bun flag semantics");
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
            commandEntries(
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

  test("Bun preloads enter the stage closure and cwd changes source resolution", () => {
    const entry = put("flags/entry.ts", "export const value = 1;");
    const preload = put("flags/preload.ts", "export const preloaded = 1;");
    const context: SourceTree = new Map([
      [`/${entry}`, entry],
      [`/${preload}`, preload],
    ]);
    const source =
      "FROM bun\nWORKDIR /app\nCOPY flags/entry.ts flags/entry.ts\nRUN bun run --cwd /app/flags --preload preload.ts entry.ts";
    expect(
      checkDockerSource(root, source, context, new Map()).join("\n"),
    ).toContain("preload.ts");
    expect(() =>
      commandEntries(
        root,
        context,
        "bun run --tsconfig-override config.json flags/entry.ts",
        "/app",
      ),
    ).toThrow("Unsupported Bun flag semantics");
  });

  test("late source-resolution flags fail closed instead of reusing an earlier preload path", () => {
    const context = tree(["preload.ts", "entry.ts"]);
    for (const flag of ["--cwd=/other", "--filter=@stll/other"]) {
      expect(() =>
        commandEntries(
          root,
          context,
          `bun run --preload preload.ts ${flag} entry.ts`,
          "/app",
        ),
      ).toThrow("after a source entry");
    }
  });

  test("Bun runtime options preserve explicit and filtered package scripts", () => {
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
      expect(commandEntries(root, context, command, "/app")).toEqual([
        "/app/flagged/entry.ts",
      ]);
    }
  });

  test("the bootstrap metadata expression requires its exact stage input", () => {
    const context: SourceTree = new Map([
      ["/app/package.json", "package.json"],
    ]);
    for (const flag of ["-p", "--print"]) {
      const command = `bun ${flag} 'require("./package.json").devDependencies.turbo'`;
      expect(commandEntries(root, context, command, "/app")).toEqual([]);
      expect(() => commandEntries(root, new Map(), command, "/app")).toThrow(
        "Bun metadata input is unavailable",
      );
    }
    expect(() =>
      commandEntries(root, context, `bun -p 'require("./missing.ts")'`, "/app"),
    ).toThrow("Unsupported Bun flag semantics");
  });

  test("remote native archives never manufacture copied or generated source modules", () => {
    const entry = put("native-add/entry.ts", 'import "./missing";');
    const context: SourceTree = new Map([["/entry.ts", entry]]);
    const checksum = "a".repeat(64);
    const prefix = `FROM bun\nWORKDIR /app\nCOPY entry.ts .\nADD --checksum=sha256:${checksum} https://example.invalid/native.tar /native.tar`;
    expect(checkDockerSource(root, prefix, context, new Map())).toEqual([]);
    expect(() =>
      checkDockerSource(
        root,
        `${prefix}\nRUN tar -xf /native.tar -C /app && bun entry.ts`,
        context,
        new Map(),
      ),
    ).toThrow("Unsupported source mutation: tar touches /app");
    for (const target of ["/app", "/app/"]) {
      expect(
        checkDockerSource(
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
      expect(() =>
        checkDockerSource(root, `FROM bun\n${add}`, context, new Map()),
      ).toThrow("Unsupported source instruction");
    }
  });

  test("every tracked Dockerfile passes the full hydrated repository check", () => {
    expect(
      checkRepositoryDockerSources(path.resolve(import.meta.dir, "..")),
    ).toEqual([]);
  }, 30_000);

  test("runs after source hydration in the installed light job with a fixed total budget", () => {
    const workflow = v.parse(
      v.object({
        jobs: v.object({
          "ci-checks-rest": v.object({
            steps: v.array(
              v.object({
                name: v.optional(v.string()),
                run: v.optional(v.string()),
                if: v.optional(v.string()),
                "timeout-minutes": v.optional(v.number()),
              }),
            ),
          }),
        }),
      }),
      Bun.YAML.parse(
        readFileSync(
          new URL("../.github/workflows/ci.yml", import.meta.url),
          "utf-8",
        ),
      ),
    );
    const steps = workflow.jobs["ci-checks-rest"].steps;
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

  test("rejects the omitted root helper even when it exists in the checkout", () => {
    const helper = "packages/scripts/src/prepared-generated-sources.ts";
    const actual = readFileSync(
      new URL(`../${helper}`, import.meta.url),
      "utf-8",
    );
    put(
      helper,
      actual.replace(
        '"./generated-files"',
        '"../../../scripts/generated-files"',
      ),
    );
    put("scripts/generated-files.ts", "export const CI_GENERATED_FILES = [];");
    const available = tree([helper]);
    expect(sourceClosureProblems(root, available, [`/app/${helper}`])).toEqual([
      `${helper} imports ../../../scripts/generated-files, unavailable in Docker stage`,
    ]);
    available.set(
      "/app/scripts/generated-files.ts",
      "scripts/generated-files.ts",
    );
    expect(sourceClosureProblems(root, available, [`/app/${helper}`])).toEqual(
      [],
    );
  });

  test("follows transitive and dynamic literal imports with cycles", () => {
    const files = [
      put("cycle/a.ts", 'import "./b"; import("./dynamic");'),
      put("cycle/b.ts", 'export * from "./a"; import "./missing.json";'),
      put("cycle/dynamic.ts", 'import "./b";'),
    ];
    expect(
      sourceClosureProblems(root, tree(files), ["/app/cycle/a.ts"]),
    ).toEqual([
      "cycle/b.ts imports ./missing.json, unavailable in Docker stage",
    ]);
  });

  test("removing any discovered source leaf makes the closure fail", () => {
    const leaves = Array.from({ length: 8 }, (_, index) =>
      put(`enumerated/leaf-${index}.ts`, "export const value = 1;"),
    );
    const entry = put(
      "enumerated/entry.ts",
      leaves.map((_, index) => `export * from "./leaf-${index}";`).join("\n"),
    );
    const sources = tree([entry, ...leaves]);
    expect(
      sourceClosureProblems(root, sources, ["/app/enumerated/entry.ts"]),
    ).toEqual([]);
    for (const leaf of leaves) {
      const missing = new Map(sources);
      missing.delete(`/app/${leaf}`);
      expect(
        sourceClosureProblems(root, missing, ["/app/enumerated/entry.ts"]),
      ).toHaveLength(1);
    }
  });

  test("only value edges from imports and named exports enter a runtime closure", () => {
    const file = put(
      "types.ts",
      'import type { A } from "./absent"; import { type B } from "./absent"; export type { C } from "./absent"; export { type D, type E } from "./absent";',
    );
    expect(
      sourceClosureProblems(root, tree([file]), ["/app/types.ts"]),
    ).toEqual([]);
    for (const [index, statement] of [
      'export { type A, value } from "./absent";',
      'export {} from "./absent";',
      'import { type A, value } from "./absent";',
    ].entries()) {
      const entry = put(`mixed-types-${index}.ts`, statement);
      expect(
        sourceClosureProblems(root, tree([entry]), [`/app/${entry}`]),
      ).toEqual([`${entry} imports ./absent, unavailable in Docker stage`]);
    }
  });

  test("declarations cannot satisfy a runtime source import", () => {
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
        sourceClosureProblems(root, tree([config, declaration, entry]), [
          `/app/${entry}`,
        ]),
      ).toEqual([`${entry} imports ${specifier}, unavailable in Docker stage`]);
    }
  });

  test("resolves dotted module basenames only from stage sources", () => {
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
          sourceClosureProblems(root, tree([config, entry, dependency]), [
            `/app/${entry}`,
          ]),
        ).toEqual([]);
        expect(
          sourceClosureProblems(root, tree([config, entry]), [`/app/${entry}`]),
        ).toEqual([
          `${entry} imports ${specifier}, unavailable in Docker stage`,
        ]);
      }
    }
  });

  test("Bun runtime and bundling tolerate a missing inherited tsconfig", () => {
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
      sourceClosureProblems(root, tree([config, entry, target]), [
        `/app/${entry}`,
      ]),
    ).toEqual([]);
    expect(
      sourceClosureProblems(root, tree([config, entry]), [`/app/${entry}`]),
    ).toEqual([`${entry} imports ~/value, unavailable in Docker stage`]);
  });

  test("every tracked tsconfig alias and custom alias requires its stage source", () => {
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
      const parsed = ts.parseConfigFileTextToJson(
        configuration,
        readFileSync(path.join(repositoryRoot, configuration), "utf-8"),
      );
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
        sourceClosureProblems(root, tree([config, entry, target]), [
          `/app/${entry}`,
        ]),
        pattern,
      ).toEqual([]);
      expect(
        sourceClosureProblems(root, tree([config, entry]), [`/app/${entry}`]),
        pattern,
      ).toEqual([`${entry} imports ${specifier}, unavailable in Docker stage`]);
    }
  });

  test("resolves aliases using only stage sources", () => {
    const files = [
      put(
        "apps/example/tsconfig.json",
        JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
      ),
      put("apps/example/src/a.ts", 'import "@/b";'),
      put("apps/example/src/b.ts", "export const b = 1;"),
    ];
    expect(
      sourceClosureProblems(root, tree(files), ["/app/apps/example/src/a.ts"]),
    ).toEqual([]);
    expect(
      sourceClosureProblems(root, tree(files.slice(0, 2)), [
        "/app/apps/example/src/a.ts",
      ]),
    ).toHaveLength(1);
  });

  test("only the most specific alias supplies targets regardless of declaration order", () => {
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
        expect(sourceClosureProblems(root, sources, [`/app/${entry}`])).toEqual(
          [`${entry} imports @/special/value, unavailable in Docker stage`],
        );
        sources.set(`/app/${specific}`, specific);
        expect(sourceClosureProblems(root, sources, [`/app/${entry}`])).toEqual(
          [],
        );
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
      sourceClosureProblems(root, tree([config, entry, fallback]), [
        `/app/${entry}`,
      ]),
    ).toEqual([]);
  });

  test("retains the declaration directory of inherited aliases", () => {
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
      sourceClosureProblems(root, tree(files), [
        "/app/apps/inherited/scripts/entry.ts",
      ]),
    ).toEqual([]);
  });

  test("checks Vite worker sources and imported assets", () => {
    const files = [
      put(
        "worker-entry.ts",
        'import "./worker?worker&url"; import "./data.txt?raw";',
      ),
      put("worker.ts", 'import "./missing";'),
      put("data.txt", "asset"),
    ];
    expect(
      sourceClosureProblems(root, tree(files), ["/app/worker-entry.ts"]),
    ).toEqual(["worker.ts imports ./missing, unavailable in Docker stage"]);
  });

  test("resolves a workspace export without checkout symlinks", () => {
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
      sourceClosureProblems(root, tree(files), ["/app/workspace-entry.ts"]),
    ).toEqual([
      "packages/example/src/index.ts imports ./absent, unavailable in Docker stage",
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

  test("checks a consumer after its actual pruned COPY, not the full context", () => {
    const entry = put("stage-entry.ts", 'import "./root-helper";');
    const helper = put("root-helper.ts", "export const value = 1;");
    const context: SourceTree = new Map([
      ["/stage-entry.ts", entry],
      ["/root-helper.ts", helper],
    ]);
    const pruned = tree([entry]);
    const dockerfile =
      "FROM bun AS pruner\nWORKDIR /app\nCOPY . .\nRUN turbo prune @stll/example --docker\nFROM bun AS builder\nWORKDIR /app\nCOPY --from=pruner /app/out/full/ .\nRUN bun stage-entry.ts";
    expect(checkDockerSource(root, dockerfile, context, pruned)).toEqual([
      "stage-entry.ts imports ./root-helper, unavailable in Docker stage",
    ]);
    pruned.set("/app/root-helper.ts", helper);
    expect(checkDockerSource(root, dockerfile, context, pruned)).toEqual([]);
  });

  test("checks every command following prune and preserves source production order", () => {
    const entry = put("prune-order/entry.ts", 'import "./out/full/value";');
    const value = put("prune-order/value.ts", "export const value = 1;");
    const context: SourceTree = new Map([["/entry.ts", entry]]);
    const pruned: SourceTree = new Map([["/app/value.ts", value]]);
    const base = "FROM bun AS pruner\nWORKDIR /app\nCOPY . .\nRUN ";
    for (const separator of ["&&", ";", "||"]) {
      const prune = "turbo prune @stll/example --docker";
      expect(
        checkDockerSource(
          root,
          `${base}${prune} ${separator} bun absent.ts`,
          context,
          pruned,
        ),
      ).toEqual(["Entry is unavailable: /app/absent.ts"]);
      expect(
        checkDockerSource(
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
        checkDockerSource(
          root,
          `${base}bun entry.ts ${separator} ${prune}`,
          context,
          pruned,
        ),
      ).toEqual([
        `${entry} imports ./out/full/value, unavailable in Docker stage`,
      ]);
      expect(() =>
        checkDockerSource(
          root,
          `${base}${prune} ${separator} npm unknown`,
          context,
          pruned,
        ),
      ).toThrow("Unsupported source runner: npm");
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

  test("expands the named build script and nested generator", () => {
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
      commandEntries(
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
      commandEntries(
        root,
        tree(files),
        "cd apps/commands && bun src/main.ts",
        "/app",
      ),
    ).toEqual(["/app/apps/commands/src/main.ts"]);
    expect(() =>
      commandEntries(root, tree(files), "bun $ENTRY", "/app"),
    ).toThrow("Unsupported");
    expect(
      commandEntries(
        root,
        tree(files),
        "bun --cwd=elsewhere src/main.ts",
        "/app",
      ),
    ).toEqual(["/app/elsewhere/src/main.ts"]);
    expect(
      commandEntries(
        root,
        tree(files),
        "bun --filter @stll/commands build && bun root.ts",
        "/app",
      ).at(-1),
    ).toBe("/app/root.ts");
    expect(
      commandEntries(
        root,
        tree(files),
        "(cd apps/commands && bun src/main.ts) && bun root.ts",
        "/app",
      ),
    ).toEqual(["/app/apps/commands/src/main.ts", "/app/root.ts"]);
  });
});
