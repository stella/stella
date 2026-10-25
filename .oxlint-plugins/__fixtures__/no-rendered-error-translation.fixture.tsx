declare const t: (key: string) => string;

// oxlint-disable-next-line no-rendered-error-translation/no-rendered-error-translation -- fixture proves raw translated alerts are rejected
export const invalid = <p role="alert">{t("errors.actionFailed")}</p>;

// expect-clean: no-rendered-error-translation/no-rendered-error-translation
export const progress = <p role="status">{t("readerAnswers.loading")}</p>;
