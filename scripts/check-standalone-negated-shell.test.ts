import { expect, test } from "bun:test";

import { findStandaloneNegatedShellStatements } from "./check-standalone-negated-shell";

const check = (file: string, source: string) =>
  findStandaloneNegatedShellStatements(new Map([[file, source]]));

test("rejects planted standalone negations in shell and workflow run blocks", () => {
  expect(
    check(
      "scripts/planted.sh",
      "#!/usr/bin/env bash\nset -e\n! grep -q x file\necho survived",
    ),
  ).toEqual([
    {
      file: "scripts/planted.sh",
      line: 3,
      source: "! grep -q x file",
    },
  ]);
  expect(
    check(
      ".github/workflows/planted.yml",
      "jobs:\n  planted:\n    steps:\n      - run: |\n          set -e\n          ! grep -q x file\n          echo survived",
    ),
  ).toEqual([
    {
      file: ".github/workflows/planted.yml",
      line: 6,
      source: "! grep -q x file",
    },
  ]);
  // A plain `run: ! cmd` is a YAML tag, so only quoted scalars carry the `!`.
  for (const run of ["'! grep -q x file'", '"! grep -q x file"']) {
    expect(
      check(
        ".github/workflows/inline.yml",
        `jobs:\n  planted:\n    steps:\n      - run: ${run}`,
      ),
    ).toEqual([
      {
        file: ".github/workflows/inline.yml",
        line: 4,
        source: "! grep -q x file",
      },
    ]);
  }
});

test("accepts negations whose status is consumed", () => {
  const source = `#!/usr/bin/env bash
if ! grep -q x file; then
  exit 1
fi
if test -f file &&
  ! grep -q x file; then
  exit 1
fi
all_success() {
  ! grep -qv ' = success$' <<< "$1"
}
if all_success "$states"; then
  echo success
fi`;
  expect(check("scripts/passing.bash", source)).toEqual([]);
});

test("accepts a negation consumed by || on the same line, not by &&", () => {
  expect(check("scripts/or.sh", "! grep -q x file || exit 1")).toEqual([]);
  expect(
    check("scripts/and.sh", "! grep -q x file && echo found"),
  ).toHaveLength(1);
  for (const line of [
    "! grep -q x file # fallback || exit 1",
    "! grep -q 'a || b' file",
    '! grep -q "a || b" file',
    "! grep -q a\\|\\|b file",
  ]) {
    expect(check("scripts/quoted.sh", line), line).toHaveLength(1);
  }
});

test("does not exempt a non-final standalone negation inside a function", () => {
  expect(
    check(
      "scripts/function.sh",
      "predicate() {\n  ! grep -q x file\n  echo continued\n}",
    ),
  ).toHaveLength(1);
});

test("checks Bash shebang files and ignores non-shell and heredoc content", () => {
  expect(
    check("scripts/no-extension", "#!/bin/bash\n! false\necho continued"),
  ).toHaveLength(1);
  expect(check("scripts/example.ts", "! command")).toEqual([]);
  expect(
    check(
      "scripts/heredoc.sh",
      "cat <<'SCRIPT'\n! this is fixture text\nSCRIPT",
    ),
  ).toEqual([]);
  expect(
    check("scripts/here-string.sh", 'cat <<< "text"\n! false\necho x'),
  ).toHaveLength(1);
});

test("rejects negations separated from a consumer or hidden in an and-or list", () => {
  for (const source of [
    "true &&\n ! true\necho continued",
    "a || ! b",
    "! true; echo ok || exit 1",
  ]) {
    expect(check("scripts/lists.sh", source), source).toHaveLength(1);
  }
});

test("recognizes condition lists across physical lines", () => {
  expect(
    check(
      "scripts/condition.sh",
      "if test -f f &&\n ! grep -q x f; then\n  echo absent\nfi",
    ),
  ).toEqual([]);
});

test("allows only final standalone pipelines to supply enclosing status", () => {
  expect(
    check("scripts/function.sh", 'all_success() { ! grep -qv x <<< "$1"; }'),
  ).toEqual([]);
  expect(check("scripts/final.sh", "echo start\n! grep -q x f")).toEqual([]);
});

test("does not interpret heredoc-like text in quotes or comments", () => {
  for (const source of [
    'echo "<<EOF"\n! true\necho x',
    "# <<EOF\n! true\necho x",
  ]) {
    expect(check("scripts/not-heredoc.sh", source), source).toHaveLength(1);
  }
});

test("skips quoted and multiple real heredoc bodies", () => {
  const source = `cat <<'FIRST' <<-SECOND
! fixture one
FIRST
\t! fixture two
\tSECOND
echo complete`;
  expect(check("scripts/heredocs.sh", source)).toEqual([]);
});

test("treats substitutions and backticks as opaque words", () => {
  const source = `echo "$(printf '! hidden')"
echo \`printf '! hidden'\`
echo $'! hidden'
! false
echo continued`;
  expect(check("scripts/substitutions.sh", source)).toEqual([
    {
      file: "scripts/substitutions.sh",
      line: 4,
      source: "! false",
    },
  ]);
});

test("recognizes loop conditions and function-keyword bodies", () => {
  expect(
    check(
      "scripts/reserved.sh",
      "while ! ready; do sleep 1; done\nfunction absent { ! grep -q x file; }",
    ),
  ).toEqual([]);
});

test("quoted operator text neither ends nor consumes a negated pipeline", () => {
  expect(
    check("scripts/quoted-operator.sh", "! grep -q '||' file\necho continued"),
  ).toHaveLength(1);
  expect(
    check(
      "scripts/quoted-brace.sh",
      "f() {\n  echo '}'\n  ! grep -q x file\n}",
    ),
  ).toEqual([]);
});

test("an unterminated heredoc ends at the end of the script", () => {
  expect(check("scripts/unterminated.sh", "cat <<EOF\nfixture")).toEqual([]);
  expect(
    check(
      "scripts/unterminated-after.sh",
      "! true\necho x\ncat <<EOF\n! false",
    ),
  ).toHaveLength(1);
});
