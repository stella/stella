import { expect, test } from "bun:test";

import {
  findEarlyExitPipelines,
  findStandaloneNegatedShellStatements,
} from "./check-standalone-negated-shell";

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

test("recognizes negation after time pipeline prefixes", () => {
  for (const timed of ["time ! true", "time -p ! true"]) {
    expect(
      check("scripts/timed.sh", `set -e\n${timed}\necho continued`),
      timed,
    ).toEqual([{ file: "scripts/timed.sh", line: 2, source: timed }]);
  }
});

test("accepts final group negations when the group status is consumed", () => {
  for (const source of [
    "if ( ! grep -q x file ); then :; fi",
    "{ ! grep -q x file; } || exit 1",
    "if { true; ! false; }; then :; fi",
  ]) {
    expect(check("scripts/consumed-group.sh", source), source).toEqual([]);
  }
});

test("rejects group negations that do not supply a consumed group status", () => {
  for (const source of [
    "if ( ! grep -q x file; true ); then :; fi",
    "{ ! grep -q x file; }\necho continued",
  ]) {
    expect(check("scripts/unconsumed-group.sh", source), source).toHaveLength(
      1,
    );
  }
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

test("an aliased step is checked once, at its anchor's run line", () => {
  const steps =
    "jobs:\n  a:\n    steps:\n      - &fetch\n        name: Fetch\n        run: |\n          echo fetch\n          RUN\n  b:\n    steps:\n      - *fetch\n      - run: echo after";
  expect(
    check(".github/workflows/alias.yml", steps.replace("RUN", "echo done")),
  ).toEqual([]);
  expect(
    check(".github/workflows/alias.yml", steps.replace("RUN", "! true")),
  ).toEqual([
    { file: ".github/workflows/alias.yml", line: 8, source: "! true" },
  ]);
  expect(
    check(
      ".github/workflows/alias-after.yml",
      "jobs:\n  a:\n    steps:\n      - &fetch\n        run: echo fetch\n      - *fetch\n      - run: |\n          ! true\n          echo x",
    ),
  ).toEqual([
    { file: ".github/workflows/alias-after.yml", line: 8, source: "! true" },
  ]);
});

test("a merge key copy of a run step fails closed", () => {
  expect(
    check(
      ".github/workflows/merge-key.yml",
      "jobs:\n  a:\n    steps:\n      - &fetch\n        run: echo fetch\n      - <<: *fetch\n        name: Again",
    ),
  ).toEqual([
    {
      file: ".github/workflows/merge-key.yml",
      line: 1,
      source: "run values do not map one-to-one onto `run:` key lines",
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

test("a terminal negation continued from an and-or line is still in the list", () => {
  expect(check("scripts/terminal-list.sh", "true &&\n  ! true")).toHaveLength(
    1,
  );
  expect(
    check(
      "scripts/terminal-list-function.sh",
      "f() {\n  true && # why\n  ! true\n}",
    ),
  ).toHaveLength(1);
});

test("a case arm inside a function or group keeps the enclosing frame", () => {
  expect(
    check(
      "scripts/case-in-function.sh",
      'f() { case "$x" in x) :;; esac; ! false; }\nif f; then :; fi',
    ),
  ).toEqual([]);
  expect(
    check(
      "scripts/case-in-group.sh",
      '{ case "$x" in (x) :;; y) :;; esac; ! false; } || exit 1',
    ),
  ).toEqual([]);
  expect(
    check(
      "scripts/case-in-subshell.sh",
      'if ( case "$x" in x) :;; esac; ! false; ); then :; fi',
    ),
  ).toEqual([]);
  expect(
    check(
      "scripts/case-pattern-named-case.sh",
      'if ( case "$x" in x) :;; case) :;; esac; ! false; ); then :; fi',
    ),
  ).toEqual([]);
  expect(
    check(
      "scripts/case-fallthrough.sh",
      'if ( case "$x" in x) : ;& y) : ;;& z) : ;; esac; ! false ); then :; fi',
    ),
  ).toEqual([]);
  expect(
    check(
      "scripts/nested-case.sh",
      '( case "$x" in x) case "$y" in (y) :;; esac;; esac; ! false ) || exit 1',
    ),
  ).toEqual([]);
  expect(
    check(
      "scripts/case-arm-negation.sh",
      'f() { case "$x" in x) ! false; echo next;; esac; }',
    ),
  ).toHaveLength(1);
});

test("a group that feeds a pipe does not pass its status on", () => {
  expect(
    check("scripts/group-pipe.sh", "if ( ! grep -q x file ) | cat; then :; fi"),
  ).toHaveLength(1);
  expect(
    check(
      "scripts/group-redirect-pipe.sh",
      "if ( ! grep -q x file ) 2>/dev/null | cat; then :; fi",
    ),
  ).toHaveLength(1);
  expect(
    check(
      "scripts/group-redirect.sh",
      "if ( ! grep -q x file ) 2>/dev/null; then :; fi",
    ),
  ).toEqual([]);
  expect(
    check("scripts/group-last.sh", "if cat | ( ! grep -q x file ); then :; fi"),
  ).toEqual([]);
});

test("escaped newlines in quotes and substitutions advance the line count", () => {
  expect(
    check(
      "scripts/continued.sh",
      'out="$(\n  run \\\n    --flag \\\n    "$x \\\n y"\n)"\n! true\necho continued',
    ),
  ).toEqual([{ file: "scripts/continued.sh", line: 7, source: "! true" }]);
});

const earlyExit = (file: string, source: string) =>
  findEarlyExitPipelines(new Map([[file, source]]));

test("pipefail fails a pipeline whose reader exits before its writer", () => {
  const run = (script: string) =>
    Bun.spawnSync(["bash", "-c", `set -o pipefail\n${script}`]).exitCode;
  // seq writes far more than one pipe buffer, so it outlives grep and is
  // killed by SIGPIPE although grep found the match.
  expect(run("seq 100000 | grep -qx 1")).not.toBe(0);
  expect(run('lines="$(seq 100000)"\ngrep -qx 1 <<<"$lines"')).toBe(0);
});

test("rejects pipes into readers that can exit early", () => {
  for (const pipeline of [
    "producer | grep -q x",
    "producer | grep -Fqx x",
    "producer | grep -m1 x",
    "producer | grep -m 1 x",
    "producer | grep --quiet x",
    "producer | grep --silent x",
    "producer | grep --max-count=1 x",
    "producer | grep -l x",
    "producer | egrep -q x",
    "producer | rg -q x",
    "producer | head -n 1",
    "producer | head",
    "producer |& head -n 1",
    "producer | LC_ALL=C grep -Eq x",
    'producer | LC_ALL="C" grep -Eq x',
    "producer | grep -iq x || true",
    "producer | sort | head -n 1",
    "producer | grep -e x -q",
  ]) {
    expect(
      earlyExit("scripts/planted.sh", pipeline).violations,
      pipeline,
    ).toEqual([{ file: "scripts/planted.sh", line: 1, source: pipeline }]);
  }
});

test("rejects the pipelines this guard replaced", () => {
  const manifestCheck = `if ! printf '%s' "$comment" | tr '\\t' '\\n' | grep -qxF "version:\${APP_VERSION}"; then
  exit 1
fi`;
  expect(
    earlyExit("scripts/build-updater-manifest.sh", manifestCheck).violations,
  ).toHaveLength(1);
  const assetLookup = `while IFS= read -r tag; do
  if bash "$gh_retry_script" release view "$tag" --json assets --jq '.assets[].name' \\
    | grep -qx 'latest.json'; then
    break
  fi
done < <(git tag --list 'v*')`;
  expect(
    earlyExit("scripts/detect-desktop-release-changes.sh", assetLookup)
      .violations,
  ).toEqual([
    {
      file: "scripts/detect-desktop-release-changes.sh",
      line: 3,
      source: "| grep -qx 'latest.json'; then",
    },
  ]);
});

test("follows pipes across lines and into command substitutions", () => {
  expect(
    earlyExit("scripts/split.sh", "producer |\n  # first match\n  head -n 1")
      .violations,
  ).toEqual([{ file: "scripts/split.sh", line: 3, source: "head -n 1" }]);
  for (const assignment of [
    'first="$(producer | head -n 1)"',
    "first=$(producer | head -n 1)",
    "first=`producer | head -n 1`",
    'echo "first: $(producer | head -n 1)"',
    'echo "$(printf "%s" "$(producer | head -n 1)")"',
  ]) {
    expect(
      earlyExit("scripts/sub.sh", assignment).violations,
      assignment,
    ).toEqual([{ file: "scripts/sub.sh", line: 1, source: assignment }]);
  }
  // Escaped newlines inside a substitution still advance the line count.
  const continued = `out="$(
  cd dir \\
    && run \\
    "$x"
)"
got="$(printf '%s\\n' "$out" | grep '^a=' | head -n1)"`;
  expect(earlyExit("scripts/continued.sh", continued).violations).toEqual([
    {
      file: "scripts/continued.sh",
      line: 6,
      source: `got="$(printf '%s\\n' "$out" | grep '^a=' | head -n1)"`,
    },
  ]);
  expect(
    earlyExit(
      ".github/workflows/planted.yml",
      'jobs:\n  planted:\n    steps:\n      - run: |\n          set -e\n          id="$(\n            gh run list \\\n              | head -n 1\n          )"',
    ).violations,
  ).toEqual([
    {
      file: ".github/workflows/planted.yml",
      line: 8,
      source: "| head -n 1",
    },
  ]);
});

test("accepts readers that see the whole input", () => {
  for (const source of [
    'grep -q x <<<"$lines"',
    "grep -Fqx x file",
    "grep -m 1 x file",
    "head -n 1 file",
    "producer | grep x",
    "producer | grep -v x | sort",
    "producer | grep -e -q x",
    "producer | grep -- -q",
    "producer | grep '-q'",
    "lookup || grep -q x file",
    "producer | tail -n 1",
    "printf '%s\\n' 'a | head -n 1'",
    'echo "a | grep -q x"',
    "# producer | head -n 1",
    "cat <<'EOF'\nproducer | head -n 1\nEOF",
    "if [[ $a == x || $b == y ]]; then :; fi",
    `echo "\${value:-a}"`,
  ]) {
    expect(earlyExit("scripts/passing.sh", source).violations, source).toEqual(
      [],
    );
  }
});

test("reports an exemption whose file no longer needs it", () => {
  expect(earlyExit(".agents/cloud-setup.sh", "producer | grep -q x")).toEqual({
    violations: [],
    staleExemptions: [],
  });
  expect(
    earlyExit(".agents/cloud-setup.sh", 'grep -q x <<<"$(producer)"'),
  ).toEqual({ violations: [], staleExemptions: [".agents/cloud-setup.sh"] });
});
