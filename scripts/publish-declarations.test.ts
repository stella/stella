import { expect, test } from "bun:test";

import { canonicalizeDeclarationImports } from "./publish-declarations";

test("declaration import permutations pack identically without rewriting types", () => {
  const imports = [
    'import type { Value } from "./value";',
    'import "./augmentation";',
    'import type * as React from "react";',
  ];
  const header = '/// <reference types="node" />\n';
  const declaration =
    "\nexport declare const make: (value: Value) => React.ReactNode;\n";
  const first = header + imports.join("\n") + declaration;
  const second = header + imports.toReversed().join("\n") + declaration;
  expect(first).not.toBe(second);
  const canonical = canonicalizeDeclarationImports(first);
  expect(canonicalizeDeclarationImports(second)).toBe(canonical);
  expect(canonical.startsWith(header)).toBe(true);
  expect(canonical.endsWith(declaration)).toBe(true);
  expect(canonicalizeDeclarationImports(canonical)).toBe(canonical);
  for (const statement of imports) {
    expect(canonical).toContain(statement);
  }
});

test("preserves import expressions, nested modules, comments and string literals", () => {
  const source = `/** API docs */
declare module "extension" {
  import type { Z } from "z";
  import type { A } from "a";
  export const value: Z | A;
}
export type Lazy = import("lazy").Value;
export type Text = "import a from b";
`;
  expect(canonicalizeDeclarationImports(source)).toBe(source);
});
