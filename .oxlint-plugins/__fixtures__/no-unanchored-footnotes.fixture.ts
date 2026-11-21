declare const document: { package: { footnotes: unknown[] } };

// oxlint-disable-next-line no-unanchored-footnotes/no-unanchored-footnotes -- Positive regression fixture for the paragraph-anchor boundary.
export const rejected = document.package.footnotes;

// expect-clean: no-unanchored-footnotes/no-unanchored-footnotes
export const readAtAnchor = (
  notesAfter: (paragraph: unknown) => unknown[],
  paragraph: unknown,
) => notesAfter(paragraph);
