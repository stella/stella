/**
 * Fixture pages served to the controlled tab through Playwright route
 * interception under a public-looking HTTPS host, so the extension's origin
 * policy admits them while the run stays offline.
 */
export const FIXTURE_ORIGIN = "https://fixtures.stella-test.example";
/** A second origin the fixture redirects to, so the redirect guard has something to refuse. */
export const ELSEWHERE_ORIGIN = "https://elsewhere.stella-test.example";
/**
 * An intranet-style host the fixture links and frames. It is routed like the
 * fixture hosts, so only the controlled tab's network rules keep it out.
 */
export const INTRANET_ORIGIN = "https://printer.local";
export const INTRANET_SECRET = "Printer admin secret";
/** A password the containment fixture reveals with a "show password" toggle. */
export const TOGGLED_SECRET = "toggle-secret-4471";
/** A password the containment fixture reveals by replacing its field. */
export const REPLACED_SECRET = "replace-secret-2290";
/** A password the user types into the containment fixture while it is theirs. */
export const HANDOFF_SECRET = "typed during the hand-off";
/** Text the containment fixture hides from view in every supported way. */
export const HIDDEN_TEXT_MARKER = "Hidden instruction";

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
  <a href="${INTRANET_ORIGIN}/admin">Printer admin</a>
</nav>
<fieldset>
  <input autocomplete="cc-number" placeholder="Card number" value="4111111111111111">
  <input autocomplete="one-time-code" placeholder="One-time code" value="424242">
  <input autocomplete="section-a new-password" placeholder="New password" type="text" value="hunter2-new">
  <input placeholder="Masked PIN" style="-webkit-text-security: disc" value="97531">
  <select aria-label="Card expiry month" autocomplete="billing cc-exp-month">
    <option value="01">01</option>
    <option value="12" selected>12</option>
  </select>
</fieldset>
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
<iframe src="${INTRANET_ORIGIN}/frame" title="Intranet frame" width="400" height="200"></iframe>
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
  "/containment.html": `<!doctype html><html><head><title>Containment</title></head><body>
<h1>Containment fixture</h1>
<p>Visible paragraph stays.</p>
<input id="account-key" type="password" value="${TOGGLED_SECRET}" aria-label="Account key">
<button onclick="document.getElementById('account-key').type = 'text'">Reveal key</button>
<div id="vault">
  <input id="vault-key" type="password" value="${REPLACED_SECRET}" aria-label="Vault key">
</div>
<button onclick="const shown = document.createElement('input'); shown.id = 'vault-key'; shown.type = 'text'; shown.value = document.getElementById('vault-key').value; shown.setAttribute('aria-label', 'Vault key'); document.getElementById('vault').replaceChildren(shown); const echo = document.createElement('p'); echo.textContent = 'Your vault key is ' + shown.value; document.getElementById('vault').append(echo);">Show vault key</button>
<div id="handoff">
  <input id="handoff-key" type="password" aria-label="Handoff key">
</div>
<button onclick="const typed = document.getElementById('handoff-key').value; const shown = document.createElement('input'); shown.id = 'handoff-key'; shown.value = typed; shown.setAttribute('aria-label', 'Handoff key'); document.getElementById('handoff').replaceChildren(shown); const echo = document.createElement('p'); echo.textContent = 'You typed ' + typed; document.getElementById('handoff').append(echo);">Show handoff key</button>
<input name="hotplate" aria-label="Hotplate" value="warm plate">
<input id="photoprint" aria-label="Photo print" value="glossy finish">
<input name="userPassword" aria-label="Camel password" value="camel-secret-81">
<input name="one_time_code" aria-label="Snake code" value="884213">
<p aria-hidden="true">${HIDDEN_TEXT_MARKER} aria</p>
<p style="opacity: 0">${HIDDEN_TEXT_MARKER} opacity</p>
<p style="visibility: hidden">${HIDDEN_TEXT_MARKER} visibility</p>
<p style="position: absolute; left: -9999px">${HIDDEN_TEXT_MARKER} offscreen</p>
<div style="width: 0; height: 0; overflow: hidden">${HIDDEN_TEXT_MARKER} collapsed</div>
<p style="position: absolute; clip: rect(0 0 0 0); width: 1px; height: 1px; overflow: hidden">${HIDDEN_TEXT_MARKER} clipped</p>
<p style="font-size: 0">${HIDDEN_TEXT_MARKER} zero font</p>
<div aria-hidden="true"><button>Concealed action</button></div>
<button onclick="window.open('${INTRANET_ORIGIN}/popup')">Open intranet window</button>
<button onclick="window.open('${INTRANET_ORIGIN}/popup-noopener', '_blank', 'noopener')">Open intranet window without opener</button>
<a href="${INTRANET_ORIGIN}/tab" target="_blank">Open intranet tab</a>
<button onclick="window.open('/beacon.html', '_blank', 'noopener')">Open beacon page</button>
<iframe src="${ELSEWHERE_ORIGIN}/frame-tools.html" title="Tools frame" width="400" height="120"></iframe>
<a href="/page2.html" target="_blank">Open second page in a new tab</a>
<button onclick="fetch('${INTRANET_ORIGIN}/api').catch(() => undefined); new Image().src = '${INTRANET_ORIGIN}/pixel.png'; new WebSocket('wss://printer.local/socket');">Call intranet</button>
<a href="/file.bin">Download binary</a>
</body></html>`,
  "/beacon.html": `<!doctype html><html><head><title>Beacon</title></head><body>
<p>Beacon page.</p>
<script>
fetch('${INTRANET_ORIGIN}/from-opened-tab').catch(() => undefined);
setTimeout(() => { window.location.href = '${INTRANET_ORIGIN}/opened-tab-navigation'; }, 300);
</script>
</body></html>`,
  "/frame-tools.html": `<!doctype html><html><head><title>Tools</title></head><body>
<button onclick="window.open('${INTRANET_ORIGIN}/frame-popup')">Frame opens intranet</button>
</body></html>`,
  "/landing.html": `<!doctype html><html><head><title>Elsewhere</title></head><body>
<p>Private text on another origin.</p>
</body></html>`,
};

export const INTRANET_PAGE = `<!doctype html><html><head><title>Printer</title></head><body>
<p>${INTRANET_SECRET}</p><button>Reset printer</button>
</body></html>`;
