import { createElement, useId } from "react";
import type { ComponentType, ReactElement } from "react";

import Svg, {
  Defs,
  G,
  LinearGradient,
  Path,
  Polygon,
  Rect,
  Stop,
} from "react-native-svg";

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
 * the web shares. `color` paints a mark drawn in the text colour (Markdown).
 */
export const DocumentMark = ({
  color,
  kind,
  size = 18,
}: DocumentMarkContract & {
  color?: string | undefined;
  size?: number | undefined;
}) => {
  // react-native-svg resolves url(#…) by a plain id, so the scope keeps
  // letters and digits only.
  const scope = `m${useId().replaceAll(/[^a-z0-9]/giu, "")}`;
  const mark: DocumentMarkArtwork = DOCUMENT_MARKS[kind];
  const gradients = mark.gradients.map((gradient) =>
    createElement(
      LinearGradient,
      { ...gradient.attrs, id: `${scope}-${gradient.id}` },
      ...gradient.stops.map((stop) => createElement(Stop, stop)),
    ),
  );

  return createElement(
    Svg,
    {
      ...(color === undefined ? {} : { color }),
      fill: mark.fill ?? "none",
      height: size,
      viewBox: mark.viewBox,
      width: size,
    },
    ...(gradients.length === 0 ? [] : [createElement(Defs, {}, ...gradients)]),
    ...mark.shapes.map((shape) => draw(shape, scope)),
  );
};

// The shared artwork's attributes are SVG's own, which react-native-svg's
// elements take by the same names.
const ELEMENTS: Record<
  MarkShape["tag"],
  ComponentType<Record<string, unknown>>
> = { g: G, path: Path, polygon: Polygon, rect: Rect };

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
    ELEMENTS[shape.tag],
    scoped(shape.attrs, scope),
    ...(shape.children ?? []).map((child) => draw(child, scope)),
  );
