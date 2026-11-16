import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-adhoc-outcome-screen";

test("rejects a hand-written HTML page in a string or template", async () => {
  const source = [
    'const a = "<!DOCTYPE html><title>Signed in</title>";',
    "const b = `<!doctype html>",
    `<html lang="en"><body>\${title}</body></html>\`;`,
    'const c = "<html><body><h1>Connected</h1></body></html>";',
  ].join("\n");
  expect(
    await lintSingleRule(RULE, source, {
      sourcePath: "packages/cli/src/auth/page.ts",
    }),
  ).toEqual([1, 2, 4]);
});

test("accepts text that names the html element without being a page", async () => {
  const source = [
    'const a = "The theme writes its class on <html>.";',
    "const b = `<body> is styled by the base layer`;",
    'const c = "<div><p>fragment</p></div>";',
  ].join("\n");
  expect(
    await lintSingleRule(RULE, source, {
      sourcePath: "apps/web/src/lib/example.ts",
    }),
  ).toEqual([]);
});

test("pages in tests, captured fixtures and the outcome owners are allowed", async () => {
  const page = 'export const page = "<!doctype html><html></html>";';
  const results = await Promise.all(
    [
      "apps/api/src/handlers/example.test.ts",
      "apps/api/src/handlers/adapters/__fixtures__/court-page.ts",
      "apps/api/src/handlers/parsers/court.test-fixture.ts",
      "scripts/generate-outcome-page.ts",
      "packages/cli/src/auth/outcome-page.gen.ts",
      "apps/api/src/handlers/visual-sandbox/srcdoc.ts",
    ].map(
      async (sourcePath) =>
        await lintSingleRule(RULE, page, { cwd: "scratch", sourcePath }),
    ),
  );
  expect(results).toEqual(results.map(() => []));
});

test("only the outcome screen closes the tab", async () => {
  const source = [
    "window.close();",
    "globalThis.close();",
    'window["close"]();',
    "dialog.close();",
    "socket.close();",
  ].join("\n");
  expect(
    await lintSingleRule(RULE, source, {
      cwd: "scratch",
      sourcePath: "apps/web/src/routes/callback.tsx",
    }),
  ).toEqual([1, 2, 3]);
  expect(
    await lintSingleRule(RULE, source, {
      cwd: "scratch",
      sourcePath: "packages/ui/src/components/outcome-screen.tsx",
    }),
  ).toEqual([]);
});

test("rejects a frame that is a whole page with a title and one way on", async () => {
  const source = [
    "const A = () => (",
    '  <div className="flex flex-1 items-center justify-center">',
    "    <Frame>",
    "      <FrameHeader>",
    "        <FrameTitle>{t('agentClaim.connectedTitle')}</FrameTitle>",
    "        <FrameDescription>{t('x')}</FrameDescription>",
    "      </FrameHeader>",
    "      <FramePanel><Button onClick={go}>{t('common.close')}</Button></FramePanel>",
    "    </Frame>",
    "  </div>",
    ");",
    "function B() {",
    "  if (declined) {",
    "    return (",
    "      <Frame><FrameHeader><FrameTitle>Declined</FrameTitle></FrameHeader></Frame>",
    "    );",
    "  }",
    "  return null;",
    "}",
    "const C = () => (",
    '  <main><Frame><FramePanel role="status"><h1>Connected</h1><p>Back</p></FramePanel></Frame></main>',
    ");",
  ].join("\n");
  expect(
    await lintSingleRule(RULE, source, {
      sourcePath: "apps/web/src/routes/example.tsx",
    }),
  ).toEqual([3, 15, 21, 21]);
});

test("accepts section cards, decisions, forms, slots and inline status lines", async () => {
  const source = [
    // A section among others on a settings page.
    "const A = () => (",
    "  <>",
    "    <Frame><FrameHeader><FrameTitle>Danger zone</FrameTitle></FrameHeader><FramePanel><Button>Delete</Button></FramePanel></Frame>",
    "    <Dialog />",
    "  </>",
    ");",
    // A decision with two ways on.
    "const B = () => (",
    "  <Frame><FrameHeader><FrameTitle>Invitation</FrameTitle></FrameHeader><FramePanel><Button>Accept</Button><Button>Decline</Button></FramePanel></Frame>",
    ");",
    // A form.
    "const C = () => (",
    "  <Frame><FrameHeader><FrameTitle>Connect your agent</FrameTitle></FrameHeader><FramePanel><Input /><Button>Approve</Button></FramePanel></Frame>",
    ");",
    // A frame whose content the caller supplies.
    "const D = ({ children }) => (",
    "  <Frame><FrameHeader><FrameTitle>Sessions</FrameTitle></FrameHeader>{children}</Frame>",
    ");",
    // An empty state titled as a section.
    "const E = () => (",
    "  <Frame><FramePanel><h2>No usage yet</h2><p>Usage appears here.</p></FramePanel></Frame>",
    ");",
    // A live status line without a heading.
    'const F = () => <p role="status">Saved</p>;',
  ].join("\n");
  expect(
    await lintSingleRule(RULE, source, {
      sourcePath: "apps/web/src/routes/example.tsx",
    }),
  ).toEqual([]);
});
