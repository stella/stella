/**
 * A court paragraph number as every export prints it: the pilcrow the reader
 * and the citation chip use, the number in the export's locale, and a
 * no-break space so the two never wrap apart ("¶ 8"; German groups 1.234).
 */
export const formatCourtParagraphMark = (
  locale: string,
  courtParagraphNumber: number,
): string =>
  `\u00b6\u00a0${new Intl.NumberFormat(locale).format(courtParagraphNumber)}`;
