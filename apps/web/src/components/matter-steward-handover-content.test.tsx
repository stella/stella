import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";

import { MatterStewardHandoverContent } from "./matter-steward-handover-content";

for (const name of ["Matter <A> & B", "ملف المكتب القانوني"]) {
  test(`handover links isolate and escape matter names: ${name}`, () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const html = renderToStaticMarkup(
      <MatterStewardHandoverContent matters={[{ id, name }]} />,
    );
    expect(html).toContain(`href="/workspaces/${id}"`);
    expect(html).toContain("<bdi");
    expect(html).not.toContain("<A>");
    expect(html).toContain(
      name === "Matter <A> & B" ? "Matter &lt;A&gt; &amp; B" : name,
    );
  });
}
