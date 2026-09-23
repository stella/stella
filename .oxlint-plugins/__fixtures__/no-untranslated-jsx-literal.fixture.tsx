// Passive regression fixture for no-untranslated-jsx-literal.

declare const t: (key: string) => string;

export const RawCopy = () => (
  // oxlint-disable-next-line no-untranslated-jsx-literal/no-untranslated-jsx-literal -- fixture: user-facing JSX text must be translated
  <button type="button">Save matter</button>
);

export const RawExpressionCopy = () => (
  // oxlint-disable-next-line no-untranslated-jsx-literal/no-untranslated-jsx-literal -- fixture: string expression children are user-facing too
  <p>{"Unable to continue"}</p>
);

export const RawTemplateCopy = () => (
  // oxlint-disable-next-line no-untranslated-jsx-literal/no-untranslated-jsx-literal -- fixture: a static template child is user-facing too
  <p>{`Unable to continue`}</p>
);

export const RawFragmentCopy = () => (
  // oxlint-disable-next-line no-untranslated-jsx-literal/no-untranslated-jsx-literal -- fixture: fragment text is user-facing too
  <>Unable to load</>
);

export const TranslatedCopy = () => (
  // expect-clean: no-untranslated-jsx-literal/no-untranslated-jsx-literal
  <button type="button">{t("common.save")}</button>
);
// expect-clean: no-untranslated-jsx-literal/no-untranslated-jsx-literal
export const TechnicalCopy = () => <code>workspaceId</code>;
// expect-clean: no-untranslated-jsx-literal/no-untranslated-jsx-literal
export const SymbolCopy = () => <span>•</span>;
// expect-clean: no-untranslated-jsx-literal/no-untranslated-jsx-literal
export const AllowedCopy = () => <span>PDF</span>;
