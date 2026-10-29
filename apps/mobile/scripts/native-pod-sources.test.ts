import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

// Keep this census independent of CocoaPods so it runs with the mobile unit tests.
const readSourcePatterns = (spec: string) => {
  const assignments = [...spec.matchAll(/\.source_files\s*=\s*([^\n]+)/gu)];
  expect(assignments.length).toBeGreaterThan(0);
  return assignments.flatMap(([, expression = ""]) => {
    expect(expression.trim()).toMatch(
      /^(?:'[^']*'|"[^"]*"|\[\s*(?:'[^']*'|"[^"]*")(?:\s*,\s*(?:'[^']*'|"[^"]*"))*\s*\])$/u,
    );
    return [...expression.matchAll(/['"]([^'"]+)['"]/gu)].flatMap(
      ([, pattern]) => (pattern ? [pattern] : []),
    );
  });
};

const selectedCSources = (spec: string, files: string[]) => {
  const patterns = readSourcePatterns(spec).map((pattern) => new Glob(pattern));
  return files.filter(
    (file) => file.endsWith(".c") && patterns.some((glob) => glob.match(file)),
  );
};

describe("native pod compilation boundaries", () => {
  test("source globs detect C compilation, including mixed extension lists", () => {
    const files = ["Module.swift", "rnnoise/rnn.c", "rnnoise/rnn.h"];
    for (const sources of [
      "'**/*.{swift,c,h}'",
      "'**/*'",
      "['*.swift', 'rnnoise/*.c']",
      '"rnnoise/rnn.c"',
    ]) {
      expect(selectedCSources(`s.source_files = ${sources}`, files)).toEqual([
        "rnnoise/rnn.c",
      ]);
    }
    expect(selectedCSources("s.source_files = '*.swift'", files)).toEqual([]);
    expect(
      selectedCSources("s.source_files = '*.{c,h}'", ["rnn.c", "rnn.h"]),
    ).toEqual(["rnn.c"]);
  });

  test("React and Expo dependency targets compile no C sources", () => {
    const modules = path.resolve(import.meta.dir, "../modules");
    const specs = [...new Glob("**/*.podspec").scanSync({ cwd: modules })].map(
      (file) => {
        const spec = readFileSync(path.join(modules, file), "utf-8");
        const name = /\.name\s*=\s*['"]([^'"]+)['"]/u.exec(spec)?.at(1);
        expect(name).toBeDefined();
        const dependencies = [
          ...spec.matchAll(/\.dependency\s+['"]([^'"]+)['"]/gu),
        ].flatMap(([, dependency]) => (dependency ? [dependency] : []));
        return { file, spec, name, dependencies };
      },
    );
    expect(specs.length).toBeGreaterThan(0);
    const reactDependencies = new Set<string>();
    for (const { dependencies } of specs) {
      for (const dependency of dependencies) {
        if (/^(?:React|Expo|RCT)/u.test(dependency)) {
          reactDependencies.add(dependency);
        }
      }
    }
    // Follow local dependency edges as well as direct framework dependencies.
    const pending = [...reactDependencies];
    for (const dependency of pending) {
      for (const { name, dependencies } of specs) {
        if (
          name &&
          !reactDependencies.has(name) &&
          dependencies.includes(dependency)
        ) {
          reactDependencies.add(name);
          pending.push(name);
        }
      }
    }
    for (const { file, spec, name } of specs) {
      if (!name || !reactDependencies.has(name)) {
        continue;
      }
      const files = [
        ...new Glob("**/*").scanSync({
          cwd: path.dirname(path.join(modules, file)),
          onlyFiles: true,
        }),
      ];
      expect(selectedCSources(spec, files), file).toEqual([]);
    }
  });
});
