import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { workflowJobSteps } from "./workflow-steps";

const reusable = Bun.YAML.parse(
  readFileSync(
    new URL("../.github/workflows/marketing-screenshots.yml", import.meta.url),
    "utf-8",
  ),
);
const updateWorkflow = Bun.YAML.parse(
  readFileSync(
    new URL(
      "../.github/workflows/marketing-screenshots-update.yml",
      import.meta.url,
    ),
    "utf-8",
  ),
);

const stepSchema = v.looseObject({
  name: v.optional(v.string()),
  id: v.optional(v.string()),
  if: v.optional(v.string()),
  uses: v.optional(v.string()),
  run: v.optional(v.string()),
  with: v.optional(v.record(v.string(), v.unknown())),
  env: v.optional(v.record(v.string(), v.unknown())),
});
const jobSchema = v.looseObject({
  needs: v.optional(v.union([v.string(), v.array(v.string())])),
  environment: v.optional(v.string()),
  steps: v.optional(v.array(stepSchema)),
});
const updateJobs = v.parse(
  v.looseObject({ jobs: v.record(v.string(), jobSchema) }),
  updateWorkflow,
).jobs;
const stepsOf = (workflow: unknown, job: string) =>
  workflowJobSteps(workflow, job).map((step) => v.parse(stepSchema, step));

// Commands the publish job's shell steps may run: shell builtins and
// coreutils that read or copy files, nothing that executes a file.
const PUBLISH_SHELL_COMMANDS = new Set([
  "[[",
  "cd",
  "cp",
  "do",
  "done",
  "echo",
  "else",
  "exit",
  "fi",
  "find",
  "for",
  "head",
  "if",
  "od",
  "pwd",
  "read",
  "set",
  "then",
  "tr",
  "wc",
  "while",
]);

/** The command word of every simple command in a shell script. */
const commandsOf = (script: string): string[] =>
  script
    .split("\n")
    .map((line) => line.replace(/#.*$/u, "").trim())
    .filter(Boolean)
    .flatMap((line) =>
      line
        .split(/\|\||&&|;|\||\$\(|<\(|\bthen\b|\bdo\b|^!|\bif\b|\bwhile\b/u)
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .map((part) => part.split(/\s+/u)[0] ?? "")
    .filter(
      (word) =>
        word !== "" &&
        !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word) &&
        !/^[\])"'<>(]/u.test(word) &&
        !/^(?:!|\]\]|\)\)?|\(\(|\\|count|done<|fi\)?)$/u.test(word),
    );

describe("screenshot update trust boundary", () => {
  test("the shell allowlist sees commands that would run branch files", () => {
    for (const script of [
      "bash scripts/x.sh",
      "./tool --flag",
      "if true; then python tool.py; fi",
      "x=$(node -e 1)",
      "echo ok && sh run.sh",
      "find . | xargs rm",
    ]) {
      expect(
        commandsOf(script).every((command) =>
          PUBLISH_SHELL_COMMANDS.has(command),
        ),
        script,
      ).toBe(false);
    }
  });

  test("the push key never reaches a reusable workflow", () => {
    // Environment secrets cannot cross workflow_call, and a reusable workflow
    // would have to declare the key as an input; the jobs that need it live
    // in the dispatched workflow itself.
    expect(JSON.stringify(reusable)).not.toContain(
      "STELLA_RELEASE_APP_PRIVATE_KEY",
    );
    const on: unknown =
      typeof updateWorkflow === "object" && updateWorkflow !== null
        ? Reflect.get(updateWorkflow, "on")
        : undefined;
    expect(
      typeof on === "object" && on !== null ? Object.keys(on) : [],
    ).toEqual(["workflow_dispatch"]);
    for (const job of Object.values(updateJobs)) {
      expect(JSON.stringify(job)).not.toContain("./.github/workflows/");
    }
  });

  test("only the publish job can reach the push key, and it runs no branch code", () => {
    const withKey = Object.entries(updateJobs)
      .filter(([, job]) =>
        JSON.stringify(job.steps ?? []).includes(
          "STELLA_RELEASE_APP_PRIVATE_KEY",
        ),
      )
      .map(([name]) => name);
    expect(withKey).toEqual(["publish"]);
    expect(
      Object.entries(updateJobs)
        .filter(([, job]) => job.environment !== undefined)
        .map(([name, job]) => [name, job.environment]),
    ).toEqual([["publish", "release-app"]]);

    const publish = stepsOf(updateWorkflow, "publish");
    // An allowlist, not a denylist: the job holds the push key, so every
    // step is pinned by name and action, and shell steps may only call the
    // commands below. Anything new fails here until reviewed.
    expect(publish.map((step) => [step.name, step.uses ?? "run"])).toEqual([
      ["Validate inputs", "run"],
      [
        "Checkout the regenerated head",
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      ],
      [
        "Download regenerated baselines",
        "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
      ],
      ["Stage validated baselines", "run"],
      [
        "Mint App token",
        "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
      ],
      [
        "Push regenerated baselines",
        "stella/.github/.github/actions/signed-commit@5764ab66e4df84cfd2e642c7d7e4678261e668f8",
      ],
    ]);
    for (const step of publish) {
      if (step.run !== undefined) {
        expect(commandsOf(step.run), step.name).toEqual(
          commandsOf(step.run).filter((command) =>
            PUBLISH_SHELL_COMMANDS.has(command),
          ),
        );
      }
    }
    const checkout = publish.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(checkout?.with?.["submodules"]).toBeUndefined();
    const index = (name: string) =>
      publish.findIndex((step) => step.name === name);
    expect(index("Stage validated baselines")).toBeGreaterThan(
      index("Download regenerated baselines"),
    );
    expect(index("Mint App token")).toBeGreaterThan(
      index("Stage validated baselines"),
    );
    expect(index("Push regenerated baselines")).toBe(publish.length - 1);
    const push = publish.at(-1);
    // Append mode builds on the checked-out head, which is the commit the
    // capture job recorded before running branch code.
    expect(push?.with?.["mode"]).toBe("append");
    expect(checkout?.with?.["ref"]).toBe(
      ["$", "{{ needs.update.outputs.sha }}"].join(""),
    );
    expect(push?.with?.["paths"]).toBe(
      "apps/landing/public/media/products/*.png",
    );

    const update = stepsOf(updateWorkflow, "update");
    expect(JSON.stringify(update)).not.toContain("app-token");
    const updateCheckout = update.find((step) => step.name === "Checkout");
    expect(updateCheckout?.with?.["persist-credentials"]).toBe(false);
    expect(updateJobs["publish"]?.needs).toBe("update");
  });
});

describe("regenerated baseline validation", () => {
  const command = (() => {
    const step = stepsOf(updateWorkflow, "publish").find(
      (candidate) => candidate.name === "Stage validated baselines",
    );
    if (step?.run === undefined) {
      throw new TypeError("Stage validated baselines has no run script");
    }
    return step.run;
  })();
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("pixels"),
  ]);
  const stage = (
    populate: (source: string) => void,
    shapeCheckout: (root: string, target: string) => void = () => {},
  ) => {
    const root = mkdtempSync(path.join(tmpdir(), "marketing-stage-"));
    try {
      const source = path.join(root, "source");
      const target = "apps/landing/public/media/products";
      mkdirSync(source);
      mkdirSync(path.join(root, target), { recursive: true });
      populate(source);
      shapeCheckout(root, target);
      const result = Bun.spawnSync(["bash", "-c", command], {
        cwd: root,
        env: { ...process.env, SOURCE: source, TARGET: target },
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        exitCode: result.exitCode,
        output: result.stdout.toString(),
        staged: readdirSync(path.join(root, target)).toSorted(),
        outside: readdirSync(root).toSorted(),
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  test("stages flat PNG files", () => {
    const result = stage((source) => {
      writeFileSync(path.join(source, "workspace-light.png"), png);
      writeFileSync(path.join(source, "review-dark.png"), png);
    });
    expect(result.exitCode, result.output).toBe(0);
    expect(result.staged).toEqual(["review-dark.png", "workspace-light.png"]);
  });

  const rejected: { name: string; populate: (source: string) => void }[] = [
    {
      name: "a file that is not a PNG",
      populate: (source) => writeFileSync(path.join(source, "x.png"), "text"),
    },
    {
      name: "a non-PNG name",
      populate: (source) => writeFileSync(path.join(source, "x.js"), png),
    },
    {
      name: "a nested path",
      populate: (source) => {
        mkdirSync(path.join(source, "nested"));
        writeFileSync(path.join(source, "nested", "x.png"), png);
      },
    },
    {
      name: "a symlink",
      populate: (source) => {
        writeFileSync(path.join(source, "real.png"), png);
        symlinkSync("/etc/hosts", path.join(source, "link.png"));
      },
    },
    {
      name: "a hidden file",
      populate: (source) => writeFileSync(path.join(source, ".x.png"), png),
    },
  ];
  test("rejects an empty upload", () => {
    expect(stage(() => {}).exitCode).toBe(1);
  });

  for (const { name, populate } of rejected) {
    test(`rejects ${name}`, () => {
      const result = stage((source) => {
        writeFileSync(path.join(source, "ok.png"), png);
        populate(source);
      });
      expect(result.exitCode, result.output).toBe(1);
      expect(result.staged).toEqual([]);
    });
  }

  test("refuses a products directory the branch replaced with a symlink", () => {
    const result = stage(
      (source) => writeFileSync(path.join(source, "ok.png"), png),
      (root, target) => {
        const elsewhere = path.join(root, "elsewhere");
        mkdirSync(elsewhere);
        rmSync(path.join(root, target), { recursive: true });
        symlinkSync(elsewhere, path.join(root, target));
      },
    );
    expect(result.exitCode, result.output).toBe(1);
  });

  test("refuses a products directory reached through a symlinked parent", () => {
    const result = stage(
      (source) => writeFileSync(path.join(source, "ok.png"), png),
      (root) => {
        const elsewhere = path.join(root, "elsewhere", "media", "products");
        mkdirSync(elsewhere, { recursive: true });
        rmSync(path.join(root, "apps/landing/public"), { recursive: true });
        symlinkSync(
          path.join(root, "elsewhere"),
          path.join(root, "apps/landing/public"),
        );
      },
    );
    expect(result.exitCode, result.output).toBe(1);
  });

  test("refuses a committed baseline that is a symlink", () => {
    const result = stage(
      (source) => writeFileSync(path.join(source, "ok.png"), png),
      (root, target) =>
        symlinkSync("/etc/hosts", path.join(root, target, "ok.png")),
    );
    expect(result.exitCode, result.output).toBe(1);
  });
});
