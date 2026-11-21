import { panic } from "better-result";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { lexShell, programWords } from "./install-free-ci";

const root = path.resolve(import.meta.dir, "..");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
type Route = { method: string; path: string };
const join = (prefix: string, suffix: string) =>
  `${prefix}/${suffix}`.replaceAll(/\/+/gu, "/").replace(/\/$/u, "") || "/";

// The routes the API serves, read off its route table. Route modules read
// the API env when they load, so its test defaults are seeded first.
await import("../apps/api/src/tests/setup-env");
const { apiRoutes } = await import("../apps/api/src/api-routes");
const served: Route[] = apiRoutes.map(({ method, path: routePath }) => ({
  method,
  path: routePath,
}));
if (served.length === 0) {
  panic("API route inventory unavailable");
}

const apiOrigin = /https:\/\/api(?:-staging)?\.stll\.app(?:\/|$)/u;
const references = (value: string) =>
  [...value.matchAll(/\$(?:\{(\w+)(?:%\/)?\}|(\w+))(\/[^\s"'?#]*)?/gu)].flatMap(
    (match) => {
      const name = match[1] ?? match[2];
      return name === undefined ? [] : [{ name, suffix: match[3] ?? "" }];
    },
  );
const records = (value: unknown): Record<string, unknown>[] => {
  if (Array.isArray(value)) {
    return value.flatMap(records);
  }
  if (!isRecord(value)) {
    return [];
  }
  return [value, ...Object.values(value).flatMap(records)];
};
type Probe = Route & { workflow: string };
type Assignment = { name: string; value: string; output?: string };
const curlTargets = (words: string[]) => {
  let explicit: string | undefined;
  let data = false;
  let get = false;
  let head = false;
  const targets: string[] = [];
  const takesValue = new Set([
    "-H",
    "--header",
    "-o",
    "--output",
    "-w",
    "--write-out",
    "--connect-timeout",
    "--max-time",
    "--retry",
    "-d",
    "--data",
    "--data-raw",
    "--data-binary",
    "--data-urlencode",
    "--json",
    "-F",
    "--form",
    "-X",
    "--request",
    "--url",
    "-u",
    "--user",
    "--proxy",
    "--cacert",
    "--cert",
  ]);
  for (let index = 1; index < words.length; index += 1) {
    const word = words.at(index) ?? panic("Missing curl argument");
    if (word === "-G" || word === "--get") {
      get = true;
    }
    if (word === "-I" || word === "--head") {
      head = true;
    }
    if (/^(-d|-F|--data(?:-|=|$)|--json(?:=|$)|--form(?:=|$))/u.test(word)) {
      data = true;
    }
    if (/^-X.+/u.test(word)) {
      explicit = word.slice(2);
    }
    if (word.startsWith("--request=")) {
      explicit = word.slice(10);
    }
    if (word.startsWith("--url=")) {
      targets.push(word.slice(6));
    }
    if (takesValue.has(word)) {
      const value = words.at(index + 1) ?? panic(`Missing curl ${word} value`);
      if (word === "-X" || word === "--request") {
        explicit = value;
      }
      if (word === "--url") {
        targets.push(value);
      }
      index += 1;
      continue;
    }
    if (!word.startsWith("-")) {
      targets.push(word);
    }
  }
  if (explicit !== undefined) {
    return { method: explicit.toUpperCase(), targets };
  }
  if (head) {
    return { method: "HEAD", targets };
  }
  return { method: data && !get ? "POST" : "GET", targets };
};
const probeBindings = (assignments: Assignment[]) => {
  const values = new Map<string, Set<string>>([
    ["E2E_API_URL", new Set(["/"])],
  ]);
  const outputs = new Map<string, Set<string>>();
  let changed = true;
  for (let iteration = 0; changed; iteration += 1) {
    if (iteration > assignments.length + 1) {
      panic("Cyclic API URL aliases cannot be resolved");
    }
    changed = false;
    for (const { name, value, output } of assignments) {
      const paths = [
        ...value.matchAll(
          /https:\/\/api(?:-staging)?\.stll\.app(?:\/[^\s"'${}]+)?/gu,
        ),
      ].map((match) => new URL(match[0]).pathname);
      for (const { name: reference, suffix } of references(value)) {
        paths.push(
          ...[...(values.get(reference) ?? [])].map((prefix) =>
            join(prefix, suffix),
          ),
        );
      }
      for (const [reference, prefixes] of outputs) {
        if (value.includes(reference)) {
          paths.push(...prefixes);
        }
      }
      for (const pathname of paths) {
        const known = values.get(name) ?? new Set<string>();
        if (!known.has(pathname)) {
          known.add(pathname);
          values.set(name, known);
          changed = true;
        }
        if (output !== undefined) {
          const exported = outputs.get(output) ?? new Set<string>();
          if (!exported.has(pathname)) {
            exported.add(pathname);
            outputs.set(output, exported);
            changed = true;
          }
        }
      }
    }
  }
  return values;
};
const jobProbes = (
  objects: Record<string, unknown>[],
  workflow: string,
): Probe[] => {
  const assignments: Assignment[] = [];
  const commands: string[][] = [];
  for (const object of objects) {
    if (isRecord(object["env"])) {
      for (const [name, value] of Object.entries(object["env"])) {
        if (typeof value === "string") {
          assignments.push({ name, value });
        }
      }
    }
    if (typeof object["run"] !== "string") {
      continue;
    }
    const source = object["run"].replaceAll(
      /\$\{\{\s*env\.(\w+)\s*\}\}/gu,
      "$$$1",
    );
    for (const event of lexShell(source)) {
      if (event.type !== "command") {
        continue;
      }
      commands.push([...programWords(event.words)]);
      for (const word of event.words) {
        const match = /^(\w+)=(.*)$/su.exec(word);
        const name = match?.[1];
        const value = match?.[2];
        if (name === undefined || value === undefined) {
          continue;
        }
        const output =
          typeof object["id"] === "string"
            ? `steps.${object["id"]}.outputs.${name}`
            : undefined;
        if (output === undefined) {
          assignments.push({ name, value });
        } else {
          assignments.push({ name, value, output });
        }
      }
    }
  }
  const values = probeBindings(assignments);
  return commands
    .filter((words) => words.at(0) === "curl")
    .flatMap((words) => {
      const { method, targets } = curlTargets(words);
      return targets.flatMap((word) => {
        if (apiOrigin.test(word)) {
          return [{ workflow, method, path: new URL(word).pathname }];
        }
        const match =
          /^\$(?:\{(\w+)(?:%\/)?\}|(\w+))(\/[^?#]*)?(?:[?#].*)?$/u.exec(word);
        const variable = match?.[1] ?? match?.[2];
        if (variable === undefined) {
          return [];
        }
        const suffix = match?.[3] ?? "";
        return [...(values.get(variable) ?? [])].map((prefix) => ({
          workflow,
          method,
          path: join(prefix, suffix),
        }));
      });
    });
};
const probes = (source: string, workflow: string): Probe[] => {
  const parsed: unknown = Bun.YAML.parse(source);
  if (!isRecord(parsed) || !isRecord(parsed["jobs"])) {
    return panic(`${workflow}: workflow jobs unavailable`);
  }
  return Object.entries(parsed["jobs"]).flatMap(([name, job]) =>
    jobProbes([{ env: parsed["env"] }, ...records(job)], `${workflow}/${name}`),
  );
};
const resolves = (probe: Route, inventory = served) => {
  if (probe.method === "GET" && ["/ready", "/health"].includes(probe.path)) {
    return true;
  }
  // The API answers HEAD with its GET route.
  const method = probe.method === "HEAD" ? "GET" : probe.method;
  return inventory.some(
    (route) =>
      route.method === method && join("", route.path) === join("", probe.path),
  );
};
test("workflow API curl probes resolve to the mounted API route and method", () => {
  const targets = [
    ...new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync({ cwd: root }),
  ].flatMap((workflow) =>
    probes(readFileSync(path.join(root, workflow), "utf-8"), workflow),
  );
  expect(
    targets.some(
      (target) =>
        target.path === "/v1/case/decisions/search" && target.method === "POST",
    ),
  ).toBe(true);
  for (const target of targets) {
    expect(resolves(target), JSON.stringify(target)).toBe(true);
  }
});
test("route mounting and probe method changes cannot retain a successful search contract", () => {
  const workflow = ".github/workflows/deploy-staging.yml";
  const source = readFileSync(path.join(root, workflow), "utf-8");
  const changed = source.replace(
    ["$", "{E2E_API_URL}/v1/case/decisions/search"].join(""),
    () => ["$", "{E2E_API_URL}/case/decisions/search"].join(""),
  );
  expect(changed).not.toBe(source);
  expect(probes(changed, workflow).some((probe) => !resolves(probe))).toBe(
    true,
  );
  expect(resolves({ method: "GET", path: "/v1/case/decisions/search" })).toBe(
    false,
  );
  expect(
    resolves(
      { method: "POST", path: "/v1/case/decisions/search" },
      served.filter((route) => route.path !== "/v1/case/decisions/search"),
    ),
  ).toBe(false);
});

test("curl request options determine the probed method without treating payloads as URLs", () => {
  const url = "https://api-staging.stll.app/v1/case/decisions/search";
  for (const options of [
    ["-XPOST"],
    ["--request=POST"],
    ["--request", "POST"],
    ["--json", url],
  ]) {
    expect(curlTargets(["curl", ...options, url])).toEqual({
      method: "POST",
      targets: [url],
    });
  }
  expect(curlTargets(["curl", "-I", url])).toEqual({
    method: "HEAD",
    targets: [url],
  });
  expect(curlTargets(["curl", "-G", "-d", url, url])).toEqual({
    method: "GET",
    targets: [url],
  });
  expect(curlTargets(["curl", "-H", url, url])).toEqual({
    method: "GET",
    targets: [url],
  });
});
test("API URL aliases remain scoped to their workflow job", () => {
  const source = `jobs:
  api:
    env:
      API_URL: https://api-staging.stll.app/health
    steps:
      - run: curl "$API_URL?check=1"
  other:
    env:
      API_URL: https://example.com/not-api
    steps:
      - run: curl "$API_URL"
      - run: curl "$API_URL_OTHER"
`;
  expect(probes(source, "fixture")).toEqual([
    { workflow: "fixture/api", method: "GET", path: "/health" },
  ]);
});

test("API aliases preserve path suffixes when resolving probe targets", () => {
  const targets = jobProbes(
    [
      {
        env: {
          ROOT: "https://api-staging.stll.app/health",
          BAD: "$ROOT/not-a-route",
          VERSIONED: "$E2E_API_URL/v1",
        },
        run: 'curl "$BAD"; curl -XPOST "$VERSIONED/case/decisions/search"',
      },
    ],
    "fixture",
  );
  expect(targets.map(({ path: pathname }) => pathname)).toEqual([
    "/health/not-a-route",
    "/v1/case/decisions/search",
  ]);
  expect(targets.map((target) => resolves(target))).toEqual([false, true]);
});
