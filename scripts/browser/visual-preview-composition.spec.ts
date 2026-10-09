import { expect, test } from "bun:test";

import { VISUAL_INNER_POLICY } from "../../apps/api/src/handlers/visual-sandbox/document";
import runtime from "../../apps/api/src/handlers/visual-sandbox/generated/runtime.js.txt" with { type: "text" };
import { sanitizeVisualHtml } from "../../apps/api/src/handlers/visual-sandbox/sanitize";
import { composeVisualDocument } from "../../apps/api/src/handlers/visual-sandbox/srcdoc";
import { launchPreviewBrowser } from "../../apps/visual-preview/browser/launch";
import { renderVisual } from "../../apps/visual-preview/src/render";

// Repository integration joins the document producer and renderer without
// making either application import the other's source.
test("previews the canonical composed sandbox document unchanged", async () => {
  const html = sanitizeVisualHtml(
    '<h1>Example composed visual</h1><script>parent.postMessage({kind:"ready"},"*")</script>',
  ).unwrap();
  const document = composeVisualDocument({
    data: {},
    html,
    renderId: crypto.randomUUID(),
    runtime,
    policy: VISUAL_INNER_POLICY,
  });
  const output = (
    await renderVisual({
      launch: launchPreviewBrowser,
      input: { document, viewport: { width: 1200 } },
    })
  ).unwrap();
  expect(output.readyFired).toBe(true);
  expect(output.consoleErrors).toEqual([]);
  expect(output.blockedRequests).toBe(0);
});
