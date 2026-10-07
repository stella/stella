import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects resolved and normalized bare path prefixes", async () => {
  expect(
    await lintSingleRule(
      "no-path-prefix-containment",
      'import path from "node:path";\npath.resolve(root, input).startsWith(root);\npath.normalize(candidate).startsWith(path.normalize(root));',
    ),
  ).toEqual([2, 3]);
});

test("rejects named platform imports stable aliases and zero index checks", async () => {
  expect(
    await lintSingleRule(
      "no-path-prefix-containment",
      'import { resolve as resolvePath } from "node:path/win32";\nconst candidate = resolvePath(root, input);\nconst alias = candidate;\nalias.indexOf(root) === 0;\n0 !== alias.indexOf(root);',
    ),
  ).toEqual([4, 5]);
});

test("accepts separator suffixed and relative path containment", async () => {
  expect(
    await lintSingleRule(
      "no-path-prefix-containment",
      `import * as path from "node:path";\nconst candidate = path.resolve(root, input);\ncandidate.startsWith(\`\${root}\${path.sep}\`);\ncandidate.startsWith(root + "/");\nconst relative = path.relative(root, candidate);\n!relative.startsWith(\`..\${path.sep}\`) && !path.isAbsolute(relative);`,
    ),
  ).toEqual([]);
});

test("leaves ordinary strings URLs and unrelated helpers alone", async () => {
  expect(
    await lintSingleRule(
      "no-path-prefix-containment",
      'import { resolve } from "other-path";\nresolve(root, input).startsWith(root);\nurl.startsWith(origin);\ntext.indexOf(prefix) === 0;',
    ),
  ).toEqual([]);
});

test("does not attribute shadowed path imports to Node", async () => {
  expect(
    await lintSingleRule(
      "no-path-prefix-containment",
      'import path from "node:path";\nfunction local(path) { path.resolve(root, input).startsWith(root); }',
    ),
  ).toEqual([]);
});
