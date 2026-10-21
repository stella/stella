import { readFileSync } from "node:fs";
import path from "node:path";

import { requiresDesktopBrowser } from "./ci-package-scope";
import { lexShell } from "./install-free-ci";

const ROOT = path.resolve(import.meta.dir, "..");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

class BrowserScopeDeclarationError extends Error {
  override name = "BrowserScopeDeclarationError";
  readonly _tag = "BrowserScopeDeclarationError";
}

// The per-suite selectors own browser consumption; admission follows their union.
export const browserSuiteInputs = (source: string): readonly string[] => {
  const workflow: unknown = Bun.YAML.parse(source);
  if (!isRecord(workflow) || !isRecord(workflow["jobs"])) {
    throw new BrowserScopeDeclarationError("Missing workflow jobs");
  }
  const browser = workflow["jobs"]["ci-browser"];
  if (!isRecord(browser) || !Array.isArray(browser["steps"])) {
    throw new BrowserScopeDeclarationError("Missing browser suite steps");
  }
  const inputs = new Set<string>();
  let selectors = 0;
  for (const step of browser["steps"]) {
    if (!isRecord(step) || typeof step["run"] !== "string") {
      continue;
    }
    let directory = ".";
    for (const event of lexShell(step["run"])) {
      if (event.type !== "command") {
        continue;
      }
      const words = event.words;
      const git = words.indexOf("git");
      if (
        git !== -1 &&
        words.at(git + 1) === "diff" &&
        words.includes("--quiet")
      ) {
        const boundary = words.indexOf("--", git);
        const paths = boundary === -1 ? [] : words.slice(boundary + 1);
        if (paths.length === 0 || paths.some((input) => /[$`]/u.test(input))) {
          throw new BrowserScopeDeclarationError(
            "Browser scope requires literal Git paths",
          );
        }
        for (const input of paths) {
          inputs.add(input);
        }
        selectors++;
      }
      if (words.at(0) === "cd") {
        const target = words.at(1);
        if (target === undefined || /[$`]/u.test(target)) {
          throw new BrowserScopeDeclarationError(
            "Browser preparation requires a literal directory",
          );
        }
        directory = path.posix.join(directory, target);
      }
      if (words.at(0) === "cp") {
        for (const input of words.slice(1, -1)) {
          if (/[$`]/u.test(input)) {
            throw new BrowserScopeDeclarationError(
              "Browser preparation requires literal copy inputs",
            );
          }
          inputs.add(path.posix.join(directory, input));
        }
      }
    }
  }
  if (selectors === 0) {
    throw new BrowserScopeDeclarationError("Missing browser suite selectors");
  }
  return [...inputs];
};

type ScopeOptions = {
  changed: readonly string[];
  root?: string | undefined;
};
// Parsing the workflow dominates; keyed by its text, an edited workflow is
// parsed again while repeated plans over one revision parse it once.
const parsedInputs = new Map<string, readonly string[]>();
const workflowInputs = (source: string) => {
  const cached = parsedInputs.get(source);
  if (cached !== undefined) {
    return cached;
  }
  const inputs = browserSuiteInputs(source);
  parsedInputs.set(source, inputs);
  return inputs;
};
export const ciBrowserScopePredicate = ({
  root = ROOT,
}: { root?: string | undefined } = {}) => {
  try {
    const inputs = workflowInputs(
      readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf-8"),
    );
    return (changed: readonly string[]): boolean =>
      changed.some((file) =>
        inputs.some((input) => file === input || file.startsWith(`${input}/`)),
      ) || requiresDesktopBrowser({ changed, root });
  } catch (error) {
    console.error("Browser scope unavailable; retaining browser suites", error);
    return (_changed: readonly string[]): boolean => true;
  }
};

export const requiresCiBrowser = ({
  changed,
  root = ROOT,
}: ScopeOptions): boolean => ciBrowserScopePredicate({ root })(changed);

if (import.meta.main) {
  console.log(String(requiresCiBrowser({ changed: process.argv.slice(2) })));
}
