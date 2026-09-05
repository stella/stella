/**
 * Fixture pages served to the controlled tab through Playwright route
 * interception under a public-looking HTTPS host, so the extension's origin
 * policy admits them while the run stays offline.
 */
export const FIXTURE_ORIGIN = "https://fixtures.stella-test.example";
/** A second origin the fixture redirects to, so the redirect guard has something to refuse. */
export const ELSEWHERE_ORIGIN = "https://elsewhere.stella-test.example";

const LONG_TEXT = Array.from(
  { length: 900 },
  (_, index) =>
    `Paragraph ${index + 1}: the notice period runs from delivery, not from dispatch, and the appeal was dismissed with costs.`,
).join(" ");

export const FIXTURE_PAGES: Record<string, string> = {
  "/index.html": `<!doctype html><html><head><title>Fixture Index</title></head><body>
<h1>Fixture index</h1>
<nav>
  <a href="/page2.html">Second page</a>
  <a href="https://example.com/decision/42">External decision 42</a>
</nav>
<form onsubmit="event.preventDefault(); document.getElementById('submitted').textContent='Submitted: ' + document.getElementById('q').value">
  <input id="q" placeholder="Search query" type="text">
  <input id="pw" placeholder="Password field" type="password">
  <select aria-label="Court">
    <option value="">Any court</option>
    <option value="supreme">Supreme Court</option>
  </select>
  <button type="submit">Run search</button>
</form>
<p id="submitted"></p>
<table>
  <tr id="row-a"><td>Case 12 C 345/2024</td><td><button onclick="document.getElementById('deleted').textContent='Deleted case 12 C 345/2024'">Delete</button></td></tr>
  <tr id="row-b"><td>Case 7 T 89/2023</td><td><button onclick="document.getElementById('deleted').textContent='Deleted case 7 T 89/2023'">Delete</button></td></tr>
</table>
<p id="deleted"></p>
<button id="drop-row" onclick="document.getElementById('row-a').remove()">Drop first row</button>
<button disabled>Archive (disabled)</button>
<a href="/redirect">Redirecting link</a>
<div style="display: contents"><p>Visible through display contents.</p></div>
<shadow-widget></shadow-widget>
<iframe src="/frame.html" title="Embedded frame" width="400" height="200"></iframe>
<article>${LONG_TEXT}</article>
<script>
  class ShadowWidget extends HTMLElement {
    connectedCallback() {
      const root = this.attachShadow({ mode: "open" });
      root.innerHTML = '<p>Shadow text inside the widget.</p><button id="sb">Shadow action</button>';
      root.getElementById("sb").addEventListener("click", () => {
        root.getElementById("sb").textContent = "Shadow clicked";
      });
    }
  }
  customElements.define("shadow-widget", ShadowWidget);
</script>
</body></html>`,
  "/frame.html": `<!doctype html><html><head><title>Frame</title></head><body>
<p>Frame text lives here.</p>
<button onclick="this.textContent='Frame clicked'">Frame action</button>
</body></html>`,
  "/page2.html": `<!doctype html><html><head><title>Second Page</title></head><body>
<h1>Second page</h1><p>You reached the second page.</p>
</body></html>`,
  "/landing.html": `<!doctype html><html><head><title>Elsewhere</title></head><body>
<p>Private text on another origin.</p>
</body></html>`,
};
