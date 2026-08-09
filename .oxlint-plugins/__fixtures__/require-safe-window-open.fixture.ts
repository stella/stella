// Passive regression fixture for
// `require-safe-window-open/require-safe-window-open`.
//
// Each rule-specific disable marks a call the rule MUST reject. If detection
// regresses, the unused directive fails the fixture harness. Unannotated calls
// must remain valid, so false positives fail the same harness.

declare const externalDocumentUrl: string;
declare const openExternalUrl: (url: string) => void;

// MUST flag: bare open resolves to the same browser-global primitive.
// oxlint-disable-next-line require-safe-window-open/require-safe-window-open -- fixture: bare browser navigation must use the sanctioned helper
export const bareGlobalOpen = open(externalDocumentUrl, "_blank");

// MUST flag: a direct call on the browser's window global.
// oxlint-disable-next-line require-safe-window-open/require-safe-window-open -- fixture: raw browser navigation must use the sanctioned helper
export const directWindow = window.open(externalDocumentUrl, "_blank");

// MUST flag: feature strings do not replace the centralized boundary.
// oxlint-disable-next-line require-safe-window-open/require-safe-window-open -- fixture: call-site opener features are optional and can drift
export const windowWithFeatures = window.open(
  externalDocumentUrl,
  "_blank",
  "noopener,noreferrer",
);

// MUST flag: static bracket notation cannot bypass the rule.
// eslint-disable-next-line require-safe-window-open/require-safe-window-open, typescript/dot-notation -- fixture: static bracket access is equivalent to window.open
export const bracketWindow = window["open"](externalDocumentUrl);

// MUST flag: globalThis exposes the same browser primitive directly.
// oxlint-disable-next-line require-safe-window-open/require-safe-window-open -- fixture: globalThis.open is the browser open primitive
export const globalOpen = globalThis.open(externalDocumentUrl);

// MUST flag: the explicit globalThis.window chain is also raw navigation.
// oxlint-disable-next-line require-safe-window-open/require-safe-window-open -- fixture: explicit globalThis.window still reaches the browser primitive
export const explicitGlobalWindow = globalThis.window.open(externalDocumentUrl);

// MUST flag: static template properties cannot bypass either member access.
export const computedGlobalWindow =
  // eslint-disable-next-line require-safe-window-open/require-safe-window-open, typescript/dot-notation -- fixture: static computed properties preserve the global call identity
  globalThis[`window`][`open`](externalDocumentUrl);

// MUST flag: immutable aliases retain the browser window's provenance.
export const aliasedWindow = () => {
  const popupHost = window;
  // oxlint-disable-next-line require-safe-window-open/require-safe-window-open -- fixture: a stable alias cannot bypass the navigation boundary
  return popupHost.open(externalDocumentUrl, "_blank");
};

// MUST flag: an alias of globalThis exposes the same open primitive.
export const aliasedGlobalThis = () => {
  const popupHost = globalThis;
  // oxlint-disable-next-line require-safe-window-open/require-safe-window-open -- fixture: a globalThis alias retains browser-global identity
  return popupHost.open(externalDocumentUrl);
};

// MUST flag: aliasing globalThis.window also retains window provenance.
export const aliasedGlobalWindow = () => {
  const popupHost = globalThis.window;
  // oxlint-disable-next-line require-safe-window-open/require-safe-window-open -- fixture: a globalThis.window alias still reaches the raw primitive
  return popupHost.open(externalDocumentUrl);
};

// MUST flag: provenance follows stable alias chains.
export const chainedWindowAlias = () => {
  const browserGlobal = globalThis;
  const browserWindow = browserGlobal.window;
  const popupHost = browserWindow;
  // oxlint-disable-next-line require-safe-window-open/require-safe-window-open -- fixture: stable alias chains cannot hide the browser global
  return popupHost.open(externalDocumentUrl);
};

// Allowed: product code delegates to the sanctioned boundary.
export const safeHelperCall = () => openExternalUrl(externalDocumentUrl);

// Allowed: an injected function named `open` shadows the browser global.
export const useInjectedOpen = (
  open: (url: string, target: string) => unknown,
) => open(externalDocumentUrl, "_blank");

// Allowed: a nested local declaration also shadows the browser global.
export const useLocallyDeclaredOpen = () => {
  const open = (url: string) => `preview:${url}`;
  return open(externalDocumentUrl);
};

// Allowed: an injected object named `window` is not the browser global.
export const useInjectedWindow = (window: { open: (url: string) => unknown }) =>
  window.open(externalDocumentUrl);

// Allowed: a stable alias of a shadowing parameter is still unrelated.
export const useInjectedWindowAlias = (window: {
  open: (url: string) => unknown;
}) => {
  const popupHost = window;
  return popupHost.open(externalDocumentUrl);
};

// Allowed: a mutable alias may be replaced before the call.
export const useMutableWindowAlias = (
  replaceHost: boolean,
  replacement: { open: (url: string) => unknown },
) => {
  let popupHost = window;
  if (replaceHost) {
    popupHost = replacement;
  }
  return popupHost.open(externalDocumentUrl);
};

// Allowed: a conditional host does not have statically proven provenance.
export const useDynamicWindowAlias = (
  useBrowserWindow: boolean,
  replacement: { open: (url: string) => unknown },
) => {
  const popupHost = useBrowserWindow ? window : replacement;
  return popupHost.open(externalDocumentUrl);
};

// Allowed: a call result is not a proven browser-global alias.
export const useResolvedWindowAlias = (
  resolvePopupHost: () => { open: (url: string) => unknown },
) => {
  const popupHost = resolvePopupHost();
  return popupHost.open(externalDocumentUrl);
};

// Allowed: a locally bound globalThis-shaped test double is not the global.
export const useInjectedGlobalThis = (
  // oxlint-disable-next-line no-shadow-restricted-names -- fixture: proves the explicit globalThis chain is binding-aware
  globalThis: {
    open: (url: string) => unknown;
    window: { open: (url: string) => unknown };
  },
) => [
  globalThis.open(externalDocumentUrl),
  globalThis.window.open(externalDocumentUrl),
];

// Allowed: aliases derived from a shadowing globalThis remain unrelated.
export const useInjectedGlobalThisAlias = (
  // oxlint-disable-next-line no-shadow-restricted-names -- fixture: proves aliases preserve local binding provenance
  globalThis: {
    window: { open: (url: string) => unknown };
  },
) => {
  const popupHost = globalThis.window;
  return popupHost.open(externalDocumentUrl);
};

// Allowed: opening a method on an ordinary domain object is unrelated.
declare const documentPreview: { open: (url: string) => unknown };
export const previewWindow = documentPreview.open(externalDocumentUrl);
