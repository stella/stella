import { Glob } from "bun";
import type { CheerioOptions } from "cheerio/slim";
import { fileURLToPath } from "node:url";
import { adapter } from "parse5-htmlparser2-tree-adapter";

import { sha256Hex } from "@stll/sha256/bun";

export const loaderModes = [
  { name: "document", options: undefined, document: true },
  { name: "fragment", options: undefined, document: false },
  {
    name: "email",
    options: { scriptingEnabled: false, treeAdapter: adapter },
    document: true,
  },
  { name: "xml", options: { xml: true }, document: true },
  { name: "xml-mode", options: { xmlMode: true }, document: true },
  {
    name: "xml-indices",
    options: {
      xml: { xmlMode: true, withStartIndices: true, withEndIndices: true },
    },
    document: true,
  },
] satisfies {
  name: string;
  options: CheerioOptions | undefined;
  document: boolean;
}[];

export const readLoaderFixtures = async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const fixtures = [
    {
      path: "synthetic",
      html: '<!doctype html><title>A &amp; B</title><noscript><p>fallback</p></noscript><table><tr><td>one&nbsp;two</table><svg viewBox="0 0 1 1"><path/></svg><script>a < b</script><textarea>&lt;x&gt;</textarea>',
    },
  ];
  const paths = Array.from(
    new Glob("src/**/*.{html,xml}").scanSync({ cwd: root }),
  ).toSorted();
  for (const path of paths) {
    const html = await Bun.file(root + path).text();
    fixtures.push({ path, html });
  }
  return fixtures;
};

export const digest = (value: string) => sha256Hex(value);
