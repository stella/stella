// parser-output-unchanged: HTML parser bindings come from their package owner; DOM and serialization behavior are unchanged.
import {
  Element as DomElement,
  hasChildren as domHasChildren,
  isCDATA as domIsCDATA,
  isComment as domIsComment,
  isTag as domIsTag,
  isText as domIsText,
  Text as DomText,
} from "domhandler";

export type { AnyNode, Element, ParentNode, Text } from "domhandler";
export const createElement = (
  ...args: ConstructorParameters<typeof DomElement>
) => new DomElement(...args);
export const createText = (data: string) => new DomText(data);
export const hasChildren = domHasChildren;
export const isCDATA = domIsCDATA;
export const isComment = domIsComment;
export const isTag = domIsTag;
export const isText = domIsText;
