// Passive regression fixture for
// no-literal-derived-attribute/no-literal-derived-attribute.
//
// The fixture override registers `encrypted` with a detector elsewhere, so
// every literal write below happens outside the detector. A required report
// carries a disable; if detection regresses, that directive becomes unused and
// fixture lint fails. Unannotated cases must remain allowed.

declare const encryption: { readonly encrypted: boolean };
declare const stored: { encrypted: boolean };
declare const writeFile: (content: {
  encrypted: boolean;
  mimeType: string;
}) => void;

writeFile({
  // oxlint-disable-next-line no-literal-derived-attribute/no-literal-derived-attribute -- fixture: a writer handed a literal records a guess
  encrypted: false,
  mimeType: "application/pdf",
});

writeFile({
  // oxlint-disable-next-line no-literal-derived-attribute/no-literal-derived-attribute -- fixture: an asserted literal is still a literal
  encrypted: true as const,
  mimeType: "application/pdf",
});

export const local = () => {
  // oxlint-disable-next-line no-literal-derived-attribute/no-literal-derived-attribute -- fixture: a local initialized to a guess
  let encrypted = false;
  const before = encrypted;
  // oxlint-disable-next-line no-literal-derived-attribute/no-literal-derived-attribute -- fixture: reassigning the local to a guess
  encrypted = true;
  return [before, encrypted];
};

// oxlint-disable-next-line no-literal-derived-attribute/no-literal-derived-attribute -- fixture: writing a guess into a record
stored.encrypted = false;

// oxlint-disable-next-line no-literal-derived-attribute/no-literal-derived-attribute -- fixture: a defaulted input lets a writer omit the value
export const decide = ({ encrypted: flag = false }: { encrypted?: boolean }) =>
  flag;

export const decideShorthand = ({
  // oxlint-disable-next-line no-literal-derived-attribute/no-literal-derived-attribute -- fixture: a defaulted destructured input
  encrypted = false,
}: {
  encrypted?: boolean;
}) => encrypted;

export class Content {
  // oxlint-disable-next-line no-literal-derived-attribute/no-literal-derived-attribute -- fixture: a class field holding a guess
  encrypted = false;
}

// expect-clean: no-literal-derived-attribute/no-literal-derived-attribute
writeFile({ encrypted: encryption.encrypted, mimeType: "application/pdf" });

// expect-clean: no-literal-derived-attribute/no-literal-derived-attribute
writeFile({ encrypted: stored.encrypted, mimeType: "application/pdf" });

// expect-clean: no-literal-derived-attribute/no-literal-derived-attribute
export const messages = { encrypted: "This PDF is encrypted." };

// expect-clean: no-literal-derived-attribute/no-literal-derived-attribute
export type Shape = { encrypted: false };

// expect-clean: no-literal-derived-attribute/no-literal-derived-attribute
export const other = { scanned: false };
