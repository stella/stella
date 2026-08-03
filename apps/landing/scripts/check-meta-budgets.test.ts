import { describe, expect, test } from "bun:test";

import { staticMetaFromSource } from "./check-meta-budgets";

describe("static page metadata extraction", () => {
  test("reads exact literal props from the Base invocation", () => {
    const source = `---
const unrelated = '<Base title="wrong" description="wrong">';
---
<section data-title="wrong" aria-description="wrong" />
<!-- <Base title="wrong" description="wrong" /> -->
<Base title="Right title" description="Right description">
  <div title="also wrong" />
</Base>`;

    expect(staticMetaFromSource("/example", source)).toEqual({
      page: "/example",
      title: "Right title",
      description: "Right description",
    });
  });

  test("does not accept prefixed or expression-valued Base props", () => {
    const source = `<Base
  data-title="wrong"
  aria-description="wrong"
  data-config={{ note: '} title="wrong" description="wrong"' }}
  title={computedTitle}
  description={computedDescription}
/>`;

    expect(staticMetaFromSource("/example", source)).toEqual({
      page: "/example",
      title: "",
      description: "",
    });
  });

  test("reports missing Base props as empty metadata", () => {
    expect(staticMetaFromSource("/example", '<Base title="Title" />')).toEqual({
      page: "/example",
      title: "Title",
      description: "",
    });
  });
});
