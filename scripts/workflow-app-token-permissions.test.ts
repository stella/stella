import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// A GitHub App token request fails as a whole when it asks for one permission
// the installation lacks, so an unused permission breaks the job that holds
// it. Each app-token step requests only permissions its installation grants,
// names them explicitly, and uses every one beyond contents in its job.

const ROOT = path.resolve(import.meta.dirname, "..");
const WORKFLOWS = path.join(ROOT, ".github/workflows");

type Access = "read" | "write";

/** Permissions each app installation grants, keyed by the app id or client id
 * the workflows pass to create-github-app-token (the expression's context path,
 * or a literal id). Mirror the organization's installation settings; never add
 * a permission the installation lacks. */
const INSTALLATION_GRANTS: Readonly<
  Record<string, Readonly<Record<string, Access>>>
> = {
  // stella-provenance-updater
  "secrets.PROVENANCE_APP_ID": {
    contents: "write",
    issues: "write",
    "pull-requests": "write",
  },
  // stella-release-deployer
  "vars.STELLA_RELEASE_APP_CLIENT_ID": {
    actions: "write",
    contents: "write",
    packages: "read",
  },
  // stella-branch-protection
  "vars.BRANCH_PROTECTION_APP_CLIENT_ID": { administration: "write" },
  // stella-cla-bot
  "2871141": {
    contents: "write",
    issues: "write",
    members: "read",
    "pull-requests": "write",
    statuses: "write",
  },
  // The changelog app: contents only.
  "secrets.CHANGELOG_APP_ID": { contents: "write" },
};

/** Evidence that a job uses a permission: an API path or CLI command that
 * needs it, in the job's run scripts, inline scripts or the files they run. */
const USAGE: Readonly<Record<string, RegExp>> = {
  actions:
    /\bgh (?:run|workflow)\b|\/actions\/|\bdispatches\b|createWorkflowDispatch/u,
  administration:
    /\/rulesets\b|\/protection\b|\bgh ruleset\b|\/actions\/permissions\b/u,
  issues:
    /\bgh (?:issue|label)\b|\/(?:issues|labels)\b|\bissues\.\w+\(|\/comments\b/u,
  members: /\/members\b|\/memberships\b|\/teams\b|\borgs\.\w+Member/u,
  packages: /\/packages\b|\bghcr\.io\b/u,
  "pull-requests":
    /\bgh pr\b|\/pulls\b|\bpulls\.\w+\(|\bpullRequest\b|^(?:pr-title|mode: refresh-pr)\b/mu,
  statuses: /\/statuses\b|\bcreateCommitStatus\b/u,
};

type Step = { uses?: unknown; run?: unknown; with?: unknown };
type Job = { steps?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStep = (value: unknown): value is Step => isRecord(value);

/** A YAML scalar input as text; anything else reads as empty. */
const scalar = (value: unknown): string =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean"
    ? String(value)
    : "";

const EXPRESSION = /^\$\{\{\s*([\w.]+)\s*\}\}$/u;
const APP_TOKEN_OUTPUT = /\bsteps\.[\w-]+\.outputs\.token\b/u;
const RELATIVE_IMPORT = /\bfrom\s+["'](\.{1,2}\/[^"']+)["']/gu;
// A second checkout (for example `.gh-retry/`) holds the same repository files.
const RUN_FILE =
  /\b(?:bun|bash|node|sh)\s+(?:run\s+)?(?:\.?[\w-]+\/(?=scripts\/))?((?:scripts|packages|apps|\.github)\/[\w./-]+\.(?:ts|mjs|js|sh))\b/gu;

/** The job's executable text: run blocks, inline github-script sources and
 * the repository files those run. */
const jobText = (steps: readonly Step[]): string => {
  const parts: string[] = [];
  for (const step of steps) {
    if (typeof step.run === "string") {
      parts.push(step.run);
    }
    if (isRecord(step.with) && typeof step.with["script"] === "string") {
      parts.push(step.with["script"]);
    }
    // An action handed the token acts with it: its inputs say what it does.
    if (
      typeof step.uses === "string" &&
      isRecord(step.with) &&
      Object.values(step.with).some(
        (value) => typeof value === "string" && APP_TOKEN_OUTPUT.test(value),
      )
    ) {
      parts.push(
        Object.entries(step.with)
          .map(([key, value]) => `${key}: ${scalar(value)}`)
          .join("\n"),
      );
    }
  }
  const pending = parts.flatMap((part) =>
    [...part.matchAll(RUN_FILE)].map((match) =>
      path.join(ROOT, match[1] ?? ""),
    ),
  );
  const read = new Set<string>();
  // Follow the run files' relative imports: the API call often lives in a
  // shared helper.
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (read.has(file) || !existsSync(file)) {
      continue;
    }
    read.add(file);
    const source = readFileSync(file, "utf-8");
    parts.push(source);
    for (const [, specifier = ""] of source.matchAll(RELATIVE_IMPORT)) {
      const target = path.resolve(path.dirname(file), specifier);
      pending.push(...[target, `${target}.ts`, path.join(target, "index.ts")]);
    }
  }
  return parts.join("\n");
};

export type AppTokenRequest = {
  job: string;
  app: string;
  permissions: Readonly<Record<string, string>>;
  text: string;
};

export const appTokenRequests = (
  file: string,
  jobs: Readonly<Record<string, Job>>,
): AppTokenRequest[] =>
  Object.entries(jobs).flatMap(([job, definition]) => {
    const steps = Array.isArray(definition.steps)
      ? definition.steps.filter(isStep)
      : [];
    return steps
      .filter(
        (step) =>
          typeof step.uses === "string" &&
          step.uses.startsWith("actions/create-github-app-token@"),
      )
      .map((step) => {
        const inputs = isRecord(step.with) ? step.with : {};
        const id = scalar(inputs["app-id"] ?? inputs["client-id"]);
        const app = EXPRESSION.exec(id)?.[1] ?? id;
        return {
          job: `${file}#${job}`,
          app,
          permissions: Object.fromEntries(
            Object.entries(inputs)
              .filter(([key]) => key.startsWith("permission-"))
              .map(([key, value]) => [
                key.slice("permission-".length),
                scalar(value),
              ]),
          ),
          text: jobText(steps),
        };
      });
  });

export const appTokenProblems = (request: AppTokenRequest): string[] => {
  const grants = INSTALLATION_GRANTS[request.app];
  if (grants === undefined) {
    return [
      `${request.job}: app ${request.app} has no entry in INSTALLATION_GRANTS; record its installation's permissions`,
    ];
  }
  const requested = Object.entries(request.permissions);
  if (requested.length === 0) {
    return [
      `${request.job}: request each permission the job needs with permission-<name> inputs instead of every installation permission`,
    ];
  }
  return requested.flatMap(([name, access]) => {
    const granted = grants[name];
    if (granted === undefined || (access === "write" && granted === "read")) {
      return [
        `${request.job}: permission-${name}: ${access} is not granted to the installation (it grants ${JSON.stringify(grants)}); drop it or grant it first`,
      ];
    }
    const usage = USAGE[name];
    if (usage !== undefined && !usage.test(request.text)) {
      return [
        `${request.job}: permission-${name} is requested but nothing in the job uses it; drop it`,
      ];
    }
    return [];
  });
};

const workflowJobs = (file: string): Record<string, Job> => {
  const parsed: unknown = Bun.YAML.parse(
    readFileSync(path.join(WORKFLOWS, file), "utf-8"),
  );
  const jobs = isRecord(parsed) ? parsed["jobs"] : undefined;
  return isRecord(jobs)
    ? Object.fromEntries(
        Object.entries(jobs).map(([name, job]) => [
          name,
          isRecord(job) ? job : {},
        ]),
      )
    : {};
};

test("every app token requests only granted permissions its job uses", () => {
  const requests = readdirSync(WORKFLOWS)
    .filter((file) => /\.ya?ml$/u.test(file))
    .toSorted()
    .flatMap((file) => appTokenRequests(file, workflowJobs(file)));
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.flatMap(appTokenProblems)).toEqual([]);
});

test("the census refuses an ungranted, unused or implicit permission", () => {
  const request = (
    permissions: Record<string, string>,
    text: string,
    app = "secrets.PROVENANCE_APP_ID",
  ): AppTokenRequest => ({ job: "w.yml#heal", app, permissions, text });
  const publish = "gh pr create --repo stella/tasks";
  expect(
    appTokenProblems(
      request({ contents: "write", "pull-requests": "write" }, publish),
    ),
  ).toEqual([]);
  expect(
    appTokenProblems(
      request(
        { contents: "write", "pull-requests": "write", issues: "write" },
        publish,
      ),
    ),
  ).toEqual([
    'w.yml#heal: permission-issues: write is not granted to the installation (it grants {"contents":"write","pull-requests":"write"}); drop it or grant it first',
  ]);
  expect(
    appTokenProblems(
      request({ contents: "write", "pull-requests": "write" }, "git push"),
    ),
  ).toEqual([
    "w.yml#heal: permission-pull-requests is requested but nothing in the job uses it; drop it",
  ]);
  expect(appTokenProblems(request({}, publish))).toEqual([
    "w.yml#heal: request each permission the job needs with permission-<name> inputs instead of every installation permission",
  ]);
  expect(
    appTokenProblems(
      request({ contents: "write" }, publish, "secrets.OTHER_APP_ID"),
    ),
  ).toEqual([
    "w.yml#heal: app secrets.OTHER_APP_ID has no entry in INSTALLATION_GRANTS; record its installation's permissions",
  ]);
});
