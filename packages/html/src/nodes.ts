import {
  type AnyNode as DomNode,
  Element as DomElement,
  hasChildren as domHasChildren,
  isCDATA as domIsCDATA,
  isComment as domIsComment,
  isTag as domIsTag,
  isText as domIsText,
  type ParentNode as DomParent,
  Text as DomText,
} from "domhandler";

export type AnyNode = DomNode;
export type ParentNode = DomParent;
export type Element = DomElement;
export const createElement = (
  ...args: ConstructorParameters<typeof DomElement>
) => new DomElement(...args);
export const createText = (data: string) => new DomText(data);
export const hasChildren = domHasChildren;
export const isCDATA = domIsCDATA;
export const isComment = domIsComment;
export const isTag = domIsTag;
export const isText = domIsText;
