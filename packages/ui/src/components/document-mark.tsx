import { createElement, useId } from "react";
import type { ReactElement, SVGProps } from "react";

import {
  DOCUMENT_MARKS,
  type DocumentMarkArtwork,
  type DocumentMarkContract,
  GRADIENT_REFERENCE,
  type MarkShape,
} from "./document-mark.shared";

export {
  isDocumentMarkKind,
  type DocumentMarkKind,
} from "./document-mark.shared";

/**
 * A file format's mark (the Word, Excel or PDF page), drawn from the artwork
 * the apps share. Decorative: the file's name says what it is.
 */
export const DocumentMark = ({ kind, ...props }: DocumentMarkProps) => {
  const scope = useId();
  const mark: DocumentMarkArtwork = DOCUMENT_MARKS[kind];
  const gradients = mark.gradients.map((gradient) =>
    createElement(
      "linearGradient",
      { ...gradient.attrs, id: `${scope}-${gradient.id}` },
      ...gradient.stops.map((stop) => createElement("stop", stop)),
    ),
  );

  return createElement(
    "svg",
    {
      "aria-hidden": true,
      fill: mark.fill ?? "none",
      xmlns: "http://www.w3.org/2000/svg",
      ...props,
      // The artwork's own coordinates; its shapes are the only children.
      viewBox: mark.viewBox,
    },
    ...(gradients.length === 0
      ? []
      : [createElement("defs", {}, ...gradients)]),
    ...mark.shapes.map((shape) => draw(shape, scope)),
  );
};

type DocumentMarkProps = DocumentMarkContract &
  Omit<SVGProps<SVGSVGElement>, "children" | "viewBox">;

/** A gradient id or paint reference, namespaced to one drawn mark. */
const scoped = (
  attrs: Readonly<Record<string, string>>,
  scope: string,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(attrs).map(([name, value]) => {
      const id = GRADIENT_REFERENCE.exec(value)?.[1];
      return [name, id === undefined ? value : `url(#${scope}-${id})`];
    }),
  );

// Children are passed as arguments, in paint order, so the fixed artwork
// needs no keys.
const draw = (shape: MarkShape, scope: string): ReactElement =>
  createElement(
    shape.tag,
    scoped(shape.attrs, scope),
    ...(shape.children ?? []).map((child) => draw(child, scope)),
  );
