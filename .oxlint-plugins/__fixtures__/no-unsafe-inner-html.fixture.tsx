// Passive regression fixture for
// `no-unsafe-inner-html/no-unsafe-inner-html`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses, the matching disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI.

const rawHtml = "<img src=x onerror=alert(1)>";

const escapeHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");

const sanitizeHtml = (value: string): string => escapeHtml(value);

const escapeRegex = (value: string): string =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

const sanitizeFilename = (value: string): string => value.replaceAll("/", "_");

export const UnsafeDangerouslySetInnerHtml = () => (
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  <div dangerouslySetInnerHTML={{ __html: rawHtml }} />
);

export const UnsafeInnerHtmlAssignment = () => {
  const element = document.createElement("div");
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  element.innerHTML = rawHtml;
  return element;
};

export const UnsafeTemplateInterpolation = () => {
  const element = document.createElement("div");
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  element.innerHTML = `<strong>${rawHtml}</strong>`;
  return element;
};

export const UnsafeRegexEscaper = () => {
  const element = document.createElement("div");
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  element.innerHTML = escapeRegex(rawHtml);
  return element;
};

export const UnsafeFilenameSanitizer = () => (
  <div
    dangerouslySetInnerHTML={{
      // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
      __html: sanitizeFilename(rawHtml),
    }}
  />
);

const hoistedPayload = { __html: rawHtml };

export const UnsafeHoistedPayload = () => (
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  <div dangerouslySetInnerHTML={hoistedPayload} />
);

const spreadPayload = { __html: rawHtml };

export const UnsafeSpreadPayload = () => (
  <div
    dangerouslySetInnerHTML={{
      // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
      ...spreadPayload,
    }}
  />
);

const shadowedSanitizeHtml = (value: string): string => value;

export const UnsafeShadowedSanitizer = () => (
  <div
    dangerouslySetInnerHTML={{
      // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
      __html: shadowedSanitizeHtml(rawHtml),
    }}
  />
);

export const UnsafeComputedInnerHtml = () => {
  const element = document.createElement("div");
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html, typescript/dot-notation -- computed member
  element["innerHTML"] = rawHtml;
  return element;
};

export const UnsafeOuterHtml = () => {
  const element = document.createElement("div");
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  element.outerHTML = rawHtml;
};

export const UnsafeInsertAdjacentHtml = () => {
  const element = document.createElement("div");
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  element.insertAdjacentHTML("beforeend", rawHtml);
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html, eslint/no-useless-call -- call form
  element.insertAdjacentHTML.call(element, "beforeend", rawHtml);
};

export const UnsafeDocumentWrite = () => {
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html, typescript/no-deprecated
  document.write(rawHtml);
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html, typescript/no-deprecated
  document.writeln("<p>", rawHtml);
  const frame = document.createElement("iframe");
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html, typescript/no-deprecated -- member document
  frame.contentDocument?.write(rawHtml);
};

export const UnsafeSrcdocProperty = () => {
  const frame = document.createElement("iframe");
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  frame.srcdoc = rawHtml;
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  frame.setAttribute("srcdoc", rawHtml);
  return frame;
};

export const UnsafeSrcdocAttribute = () => (
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  <iframe sandbox="" srcDoc={rawHtml} title="preview" />
);

declare const shadowRoot: ShadowRoot;

export const UnsafeSetHtmlUnsafe = () => {
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  shadowRoot.setHTMLUnsafe(rawHtml);
};

export const UnsafeContextualFragment = () =>
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  document.createRange().createContextualFragment(rawHtml);

export const UnsafeObjectAssign = () =>
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  Object.assign(document.createElement("div"), { innerHTML: rawHtml });

declare const React: {
  createElement: (type: string, props: object | null) => unknown;
};
declare const jsx: (type: string, props: object) => unknown;
declare const createElement: (type: string, props: object) => unknown;

export const UnsafeReactCreateElement = () =>
  React.createElement("div", {
    // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- createElement props
    dangerouslySetInnerHTML: { __html: rawHtml },
  });

export const UnsafeJsxRuntimeCall = () =>
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- jsx() props
  jsx("div", { dangerouslySetInnerHTML: { __html: rawHtml } });

export const UnsafeImportedCreateElementShorthand = () => {
  const dangerouslySetInnerHTML = { __html: rawHtml };
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- shorthand property
  return createElement("div", { dangerouslySetInnerHTML });
};

export const UnsafeSpreadProps = () => {
  const props = {
    // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- props object spread into JSX
    dangerouslySetInnerHTML: { __html: rawHtml },
  };
  return <div {...props} />;
};

export const UnsafeEmptyWaiver = () => {
  const element = document.createElement("div");
  // safe-html:
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- a marker without provenance text
  element.innerHTML = rawHtml;
  return element;
};

export const UnsafeSecondSinkOnWaivedLine = (frame: HTMLIFrameElement) => {
  // safe-html: fixture value stands in for server-side escaped markup
  Object.assign(frame, { innerHTML: rawHtml, srcdoc: rawHtml }); // oxlint-disable-line no-unsafe-inner-html/no-unsafe-inner-html -- one marker covers one sink
};

// --- Cases the rule MUST NOT flag ---

export const SafeSanitizedCallWithProvenance = () => (
  <div
    dangerouslySetInnerHTML={{
      // safe-html: sanitized locally by the fixture's escaping sanitizeHtml helper
      __html: sanitizeHtml(rawHtml),
    }}
  />
);

export const SafeAnnotatedSource = () => (
  <div
    dangerouslySetInnerHTML={{
      // safe-html: fixture value stands in for server-side escaped markup
      __html: rawHtml,
    }}
  />
);

export const SafeTemplateInterpolation = () => {
  const element = document.createElement("div");
  // safe-html: rawHtml is escaped by escapeHtml before interpolation
  element.innerHTML = `<strong>${escapeHtml(rawHtml)}</strong>`;
  return element;
};

export const safeStaticMarkup = () => {
  const element = document.createElement("div");
  // expect-clean: no-unsafe-inner-html/no-unsafe-inner-html
  element.innerHTML = "<span>Static</span>";
  return element;
};

export const SafeStaticSrcdoc = () => (
  // expect-clean: no-unsafe-inner-html/no-unsafe-inner-html
  <iframe sandbox="" srcDoc="<p>Static</p>" title="preview" />
);

export const SafeAnnotatedWrite = () => {
  const frame = document.createElement("iframe");
  // safe-html: fixture value stands in for server-side escaped markup
  frame.srcdoc = rawHtml;
};

export const SafeTextContentAssign = () =>
  // expect-clean: no-unsafe-inner-html/no-unsafe-inner-html
  Object.assign(document.createElement("div"), { textContent: rawHtml });

declare const stream: { write: (chunk: string) => void };
// expect-clean: no-unsafe-inner-html/no-unsafe-inner-html
stream.write(rawHtml);

// A plain object with a `__html` property is data, not a DOM sink until it is
// passed to `dangerouslySetInnerHTML`.
// expect-clean: no-unsafe-inner-html/no-unsafe-inner-html
export const htmlPayload = { __html: rawHtml };
