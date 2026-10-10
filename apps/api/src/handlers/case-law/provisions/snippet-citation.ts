/** Exact UTF-16 offsets in the displayed sentence, only when the print is unambiguous. */
export const snippetCitation = (
  sentenceText: string | null,
  printText: string | null,
) => {
  if (sentenceText === null || printText === null || printText === "") {
    return null;
  }
  const start = sentenceText.indexOf(printText);
  if (start === -1 || sentenceText.includes(printText, start + 1)) {
    return null;
  }
  return { start, end: start + printText.length };
};
