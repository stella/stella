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

test("a case arm starts a command", () => {
  expect(
    check(
      "scripts/case.sh",
      'case "$x" in x) ! true; echo continued;; esac\necho end',
    ),
  ).toHaveLength(1);
});

test("folded workflow blocks are analysed as YAML joins them", () => {
  expect(
    check(
      ".github/workflows/folded.yml",
      "jobs:\n  folded:\n    steps:\n      - run: >\n          echo hello\n          ! false\n          echo end",
    ),
  ).toEqual([]);
  expect(
    check(
      ".github/workflows/folded-lines.yml",
      "jobs:\n  folded:\n    steps:\n      - run: >\n          echo hello\n\n          ! false\n\n          echo end",
    ),
  ).toHaveLength(1);
});

test("workflow run values follow YAML block scalar semantics", () => {
  expect(
    check(
      ".github/workflows/indented.yml",
      "jobs:\n  a:\n    steps:\n      - run: |2\n            ! grep -q x file\n          echo continued",
    ),
  ).toEqual([
    {
      file: ".github/workflows/indented.yml",
      line: 5,
      source: "! grep -q x file",
    },
  ]);
  expect(
    check(
      ".github/workflows/folded-consumed.yml",
      "jobs:\n  a:\n    steps:\n      - run: >\n          ! grep -q x file\n          || exit 1",
    ),
  ).toEqual([]);
  expect(
    check(
      ".github/workflows/defaults.yml",
      "defaults:\n  run:\n    shell: bash\njobs:\n  a:\n    steps:\n      - run: |\n          ! true\n          echo x",
    ),
  ).toHaveLength(1);
});

test("a condition negation counts only in the list that decides the condition", () => {
  expect(
    check("scripts/condition-discarded.sh", "if ! true; true; then echo x; fi"),
  ).toHaveLength(1);
  expect(
    check(
      "scripts/condition-continued.sh",
      "if ! grep -q x file &&\n  # still the condition\n  test -f other; then echo ok; fi",
    ),
  ).toEqual([]);
  expect(
    check(
      "scripts/condition-list-discarded.sh",
      "if ! true && echo absent; true; then echo x; fi",
    ),
  ).toHaveLength(1);
  expect(
    check(
      "scripts/condition-kept.sh",
      "if true; ! false; then echo x; fi\nwhile ! ready && sleep 1; do :; done",
    ),
  ).toEqual([]);
});

test("grouped negated pipelines reach their consuming operator", () => {
  expect(
    check(
      "scripts/grouped.sh",
      "! (grep -q x file) || exit 1\n! { grep -q x file; } || exit 1",
    ),
  ).toEqual([]);
  expect(
    check("scripts/grouped-bare.sh", "! { grep -q x file; }\necho x"),
  ).toHaveLength(1);
});

test("redirections with & stay inside the negated pipeline", () => {
  expect(
    check(
      "scripts/redirect.sh",
      "if ! command -v jq >/dev/null 2>&1; then exit 1; fi\n! grep -q x file &>/dev/null || exit 1",
    ),
  ).toEqual([]);
  expect(
    check("scripts/redirect-bare.sh", "! grep -q x file 2>&1\necho x"),
  ).toHaveLength(1);
});

test("substitutions inside double quotes keep their own quotes", () => {
  expect(
    check(
      "scripts/nested-quotes.sh",
      'if ! value="$(\n  lookup --jq ".x == \\"y\\"" | head -n 1\n)"; then\n  exit 1\nfi',
    ),
  ).toEqual([]);
  expect(
    check("scripts/nested-bare.sh", '! value="$(echo "a")"\necho x'),
  ).toEqual([
    {
      file: "scripts/nested-bare.sh",
      line: 1,
      source: '! value="$(echo "a")"',
    },
  ]);
});

test("substitutions balance their own parentheses and quotes", () => {
  expect(
    check(
      "scripts/jq.sh",
      'if ! id="$(gh api x --jq ".[] | select(.a == \\"b\\") | .id")"; then\n  exit 1\nfi\n! true\necho x',
    ),
  ).toEqual([{ file: "scripts/jq.sh", line: 4, source: "! true" }]);
});

test("a function body brace may start on the next line", () => {
  expect(
    check(
      "scripts/allman.sh",
      "predicate()\n{\n  ! grep -q x file\n}\nfunction other\n{\n  ! grep -q y file\n}\nif predicate; then echo x; fi",
    ),
  ).toEqual([]);
});

test("comments between a negation and its consumer do not hide the consumer", () => {
  expect(
    check(
      "scripts/commented.sh",
      "if ! grep -q x file # explanation\nthen\n  echo absent\nfi\nf() {\n  ! grep -q y file # last\n}",
    ),
  ).toEqual([]);
});

test("arithmetic commands are not shell negations or heredocs", () => {
  expect(
    check("scripts/arith.sh", "if (( ! ready )); then echo waiting; fi"),
  ).toEqual([]);
  expect(
    check(
      "scripts/arith-shift.sh",
      "(( mask = 1 << 2 ))\n! true\necho continued",
    ),
  ).toHaveLength(1);
});

test("run: text inside a block scalar is not a run key", () => {
  expect(
    check(
      ".github/workflows/heredoc-run.yml",
      "jobs:\n  a:\n    steps:\n      - run: |\n          cat <<EOF\n          run: example\n          EOF\n          ! true\n          echo x",
    ),
  ).toEqual([
    {
      file: ".github/workflows/heredoc-run.yml",
      line: 8,
      source: "! true",
    },
  ]);
});

test("operators inside [[ ]] belong to the conditional expression", () => {
  expect(
    check(
      "scripts/conditional.sh",
      '[[ -f file || ! -d "dir ]]" ]]\necho continued\nif [[ ! -f x ]]; then exit 1; fi',
    ),
  ).toEqual([]);
  expect(
    check("scripts/conditional-negated.sh", "! [[ -f file ]]\necho continued"),
  ).toHaveLength(1);
});

test("ANSI-C strings honour escaped quotes", () => {
  expect(
    check("scripts/ansi.sh", "echo $'it\\'s'\n! false\necho continued"),
  ).toHaveLength(1);
});

test("parameter expansions are single word parts", () => {
  expect(
    check(
      "scripts/expansion.sh",
      // Escaped `\${`: the shell text holds parameter expansions, not JS.
      `echo \${#items[@]} \${name:-"a}b"}\n! false\necho continued\nf() {\n  echo \${x}\n  ! grep -q y file\n}`,
    ),
  ).toHaveLength(1);
});

test("for and select loops keep the enclosing condition frame", () => {
  expect(
    check(
      "scripts/loops.sh",
      "if a; then\n  for f in *; do :; done\nelif ! b; then\n  exit 1\nfi\nselect x in a b; do break; done\n! false\necho x",
    ),
  ).toEqual([{ file: "scripts/loops.sh", line: 7, source: "! false" }]);
});
