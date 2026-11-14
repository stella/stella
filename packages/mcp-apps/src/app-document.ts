/**
 * One MCP app document, held as the pieces it is assembled from. The build
 * stores what every app shares (the React runtime, the shared stylesheet)
 * once, so the API bundle carries one copy instead of one per app.
 */
export type McpAppDocumentParts = {
  /** The app's HTML split where the styles and the scripts go. */
  readonly shell: readonly [head: string, body: string, end: string];
  /** Stylesheets in cascade order, escaped for a `<style>` element. */
  readonly styles: readonly string[];
  /** Classic scripts that run before the app, escaped for `<script>`. */
  readonly scripts: readonly string[];
  /** The app's own module script, escaped for `<script>`. */
  readonly module: string;
};

/**
 * The self-contained document a host renders: every style and script is
 * inline, so the resource needs no URL the host's CSP would have to allow.
 */
export const assembleMcpAppDocument = ({
  shell: [head, body, end],
  styles,
  scripts,
  module,
}: McpAppDocumentParts): string =>
  [
    head,
    ...styles.map((style) => `<style>${style}</style>`),
    body,
    ...scripts.map((script) => `<script>${script}</script>`),
    `<script type="module">${module}</script>`,
    end,
  ].join("");
