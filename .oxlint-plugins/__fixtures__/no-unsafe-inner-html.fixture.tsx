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

const sanitizeFilename = (value: string): string =>
  value.replaceAll("/", "_");

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

// --- Cases the rule MUST NOT flag ---

export const SafeSanitizedCall = () => (
  <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(rawHtml) }} />
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
  element.innerHTML = `<strong>${escapeHtml(rawHtml)}</strong>`;
  return element;
};

export const safeStaticMarkup = () => {
  const element = document.createElement("div");
  element.innerHTML = "<span>Static</span>";
  return element;
};

// A plain object with a `__html` property is data, not a DOM sink until it is
// passed to `dangerouslySetInnerHTML`.
export const htmlPayload = { __html: rawHtml };
