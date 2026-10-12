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
const reusableJobs = v.parse(
  v.looseObject({ jobs: v.record(v.string(), jobSchema) }),
  reusable,
).jobs;
const stepsOf = (workflow: unknown, job: string) =>
  workflowJobSteps(workflow, job).map((step) => v.parse(stepSchema, step));

describe("screenshot update trust boundary", () => {
  test("the push key is never handed to the reusable workflow", () => {
    for (const name of [
      "marketing-screenshots.yml",
      "marketing-screenshots-update.yml",
    ]) {
      const workflow = Bun.YAML.parse(
        readFileSync(
          new URL(`../.github/workflows/${name}`, import.meta.url),
          "utf-8",
        ),
      );
      const call: unknown =
        typeof workflow === "object" && workflow !== null
          ? Reflect.get(Reflect.get(workflow, "on") ?? {}, "workflow_call")
          : undefined;
      expect(JSON.stringify(call ?? {}), name).not.toContain(
        "STELLA_RELEASE_APP_PRIVATE_KEY",
      );
    }
    expect(
      readFileSync(
        new URL(
          "../.github/workflows/marketing-screenshots-update.yml",
          import.meta.url,
        ),
        "utf-8",
      ),
    ).not.toContain("STELLA_RELEASE_APP_PRIVATE_KEY");
  });

  test("only the publish job can reach the push key, and it runs no branch code", () => {
    const withKey = Object.entries(reusableJobs)
      .filter(([, job]) =>
        JSON.stringify(job.steps ?? []).includes(
          "STELLA_RELEASE_APP_PRIVATE_KEY",
        ),
      )
      .map(([name]) => name);
    expect(withKey).toEqual(["publish"]);
    expect(
      Object.entries(reusableJobs)
        .filter(([, job]) => job.environment !== undefined)
        .map(([name, job]) => [name, job.environment]),
    ).toEqual([["publish", "release-app"]]);

    const publish = stepsOf(reusable, "publish");
    for (const step of publish) {
      // A local action would resolve from the checked-out branch.
      expect(step.uses?.startsWith("./") ?? false).toBe(false);
      expect(step.run ?? "").not.toMatch(/\bbun\b|\bnpm\b|\bnode\b|\bmake\b/u);
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

    const update = stepsOf(reusable, "update");
    expect(JSON.stringify(update)).not.toContain("app-token");
    const updateCheckout = update.find((step) => step.name === "Checkout");
    expect(updateCheckout?.with?.["persist-credentials"]).toBe(false);
    expect(reusableJobs["publish"]?.needs).toBe("update");
  });
});

describe("regenerated baseline validation", () => {
  const command = (() => {
    const step = stepsOf(reusable, "publish").find(
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
