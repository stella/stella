import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE_NAME = "no-ad-hoc-chat-link";
const lint = async (source: string, sourcePath = "chat-surface.tsx") =>
  await lintSingleRule(RULE_NAME, source, { sourcePath });

describe.serial(RULE_NAME, () => {
  test("rejects independent anchors and browser favicon sources", async () => {
    const source = [
      'export const One = () => <a href="https://example.org">Title</a>;',
      "export const Two = () => <a href={href}>Title</a>;",
      `export const Three = () => <img src={\`https://\${hostname}/favicon.ico\`} />;`,
      'export const Four = () => <img src="https://icons.example/favicon?domain=example.org" />;',
      "export const markdown = { a: (props) => <a {...props} /> };",
      'export const ProtocolRelative = () => <a href="//example.org">Title</a>;',
      'export const BackslashRelative = () => <a href="/\\\\example.org">Title</a>;',
    ].join("\n");
    expect(await lint(source)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("accepts canonical delegates and same-document navigation", async () => {
    const source = [
      'export const One = () => <ChatLink href="https://example.org">Title</ChatLink>;',
      'export const Two = () => <a href="#paragraph">Jump</a>;',
      'export const Three = () => <a href="/workspaces/id">Matter</a>;',
      "export const markdown = { a: (props) => <StreamdownMentionLink {...props} /> };",
    ].join("\n");
    expect(await lint(source)).toEqual([]);
  });

  test("allows the shared anchor owner only", async () => {
    const source = "export const Link = () => <a href={href}>Title</a>;";
    expect(await lint(source, "packages/chat/src/link.tsx")).toEqual([]);
    expect(await lint(source, "packages/chat/src/copy.tsx")).toEqual([1]);
    expect(
      await lint(
        'export const Icon = () => <img src="https://example.org/favicon.ico" />;',
        "packages/chat/src/link.tsx",
      ),
    ).toEqual([1]);
  });

  test("limits specialized legal navigation to the internal branch", async () => {
    const source = [
      "export const One = () => <a href={sanitizeHref(citation.url)}>Citation</a>;",
      'export const Two = () => <a href={sanitizeHref(citation.url)} target="_blank">Citation</a>;',
      "export const Three = () => <a href={sanitizeHref(citation.source_url)}>Source</a>;",
      "export const Four = () => <a href={sanitizeHref(citation.url)} {...props}>Citation</a>;",
    ].join("\n");
    expect(await lint(source, "legal-citation-link.tsx")).toEqual([2, 3, 4]);
  });
});
