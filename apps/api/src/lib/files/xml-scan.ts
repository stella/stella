import { Result, TaggedError } from "better-result";

export type XmlElementMatch = {
  start: number;
  end: number;
  openEnd: number;
  contentStart: number;
  contentEnd: number;
  name: string;
  openTag: string;
  closeTag: string;
  selfClosing: boolean;
};

export type XmlElementSelector = string | { prefix: string };

export type FirstXmlElementResult =
  | { kind: "found"; match: XmlElementMatch }
  | { kind: "absent" }
  | { kind: "incomplete" };

export class XmlScanError extends TaggedError("XmlScanError")<{
  message: string;
}> {}

type XmlScanCompletion = { status: "complete" } | { status: "incomplete" };

type NonElementMarkupResult =
  | { kind: "element" }
  | { kind: "skipped"; cursor: number }
  | { kind: "incomplete" };

const skipNonElementMarkup = (
  xml: string,
  start: number,
): NonElementMarkupResult => {
  let terminator: string | null = null;
  if (xml.startsWith("<!--", start)) {
    terminator = "-->";
  } else if (xml.startsWith("<![CDATA[", start)) {
    terminator = "]]>";
  } else if (xml.startsWith("<?", start)) {
    terminator = "?>";
  } else if (!xml.startsWith("<!", start)) {
    return { kind: "element" };
  }

  if (terminator !== null) {
    const end = xml.indexOf(terminator, start + 2);
    return end === -1
      ? { kind: "incomplete" }
      : { kind: "skipped", cursor: end + terminator.length };
  }

  let quote: '"' | "'" | null = null;
  for (let cursor = start + 2; cursor < xml.length; cursor += 1) {
    const character = xml[cursor];
    if (quote === null && (character === '"' || character === "'")) {
      quote = character;
    } else if (character === quote) {
      quote = null;
    } else if (quote === null && character === ">") {
      return { kind: "skipped", cursor: cursor + 1 };
    }
  }
  return { kind: "incomplete" };
};

const isNameBoundary = (character: string | undefined): boolean =>
  character === ">" || character === "/" || /\s/u.test(character ?? "");

const matchesSelector = (
  name: string,
  selector: XmlElementSelector,
): boolean =>
  typeof selector === "string"
    ? name === selector
    : name.startsWith(`${selector.prefix}:`);

type MatchingCloseOptions = {
  xml: string;
  name: string;
  openEnd: number;
};

const findMatchingClose = ({
  xml,
  name,
  openEnd,
}: MatchingCloseOptions): { closingStart: number; end: number } | null => {
  let depth = 1;
  let cursor = openEnd;
  while (cursor < xml.length) {
    const tagStart = xml.indexOf("<", cursor);
    if (tagStart === -1) {
      return null;
    }
    const markup = skipNonElementMarkup(xml, tagStart);
    if (markup.kind === "incomplete") {
      return null;
    }
    if (markup.kind === "skipped") {
      cursor = markup.cursor;
      continue;
    }
    const closing = xml[tagStart + 1] === "/";
    const tagNameStart = tagStart + (closing ? 2 : 1);
    let tagNameEnd = tagNameStart;
    while (tagNameEnd < xml.length && !isNameBoundary(xml[tagNameEnd])) {
      tagNameEnd += 1;
    }

    let tagEndIndex = tagNameEnd;
    let quote: '"' | "'" | null = null;
    while (tagEndIndex < xml.length) {
      const character = xml[tagEndIndex];
      if (quote === null && (character === '"' || character === "'")) {
        quote = character;
      } else if (character === quote) {
        quote = null;
      } else if (quote === null && character === ">") {
        break;
      }
      tagEndIndex += 1;
    }
    if (tagEndIndex === xml.length) {
      return null;
    }
    cursor = tagEndIndex + 1;

    if (xml.slice(tagNameStart, tagNameEnd) !== name) {
      continue;
    }
    if (closing) {
      depth -= 1;
      if (depth === 0) {
        return { closingStart: tagStart, end: cursor };
      }
      continue;
    }

    let slash = tagEndIndex - 1;
    while (slash >= tagNameEnd && /\s/u.test(xml[slash] ?? "")) {
      slash -= 1;
    }
    if (xml[slash] !== "/") {
      depth += 1;
    }
  }
  return null;
};

/** @yields Each complete matching element in document order. */
export const xmlElements = function* (
  xml: string,
  selector: XmlElementSelector,
): Generator<XmlElementMatch, XmlScanCompletion> {
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf("<", cursor);
    if (start === -1) {
      return { status: "complete" };
    }
    const markup = skipNonElementMarkup(xml, start);
    if (markup.kind === "incomplete") {
      return { status: "incomplete" };
    }
    if (markup.kind === "skipped") {
      cursor = markup.cursor;
      continue;
    }
    const nameStart = start + 1;
    if (xml[nameStart] === "/") {
      cursor = nameStart;
      continue;
    }
    let nameEnd = nameStart;
    while (nameEnd < xml.length && !isNameBoundary(xml[nameEnd])) {
      nameEnd += 1;
    }
    const name = xml.slice(nameStart, nameEnd);
    if (!matchesSelector(name, selector)) {
      cursor = nameEnd;
      continue;
    }
    let openEndIndex = nameEnd;
    let quote: '"' | "'" | null = null;
    while (openEndIndex < xml.length) {
      const character = xml[openEndIndex];
      if (quote === null && (character === '"' || character === "'")) {
        quote = character;
      } else if (character === quote) {
        quote = null;
      } else if (quote === null && character === ">") {
        break;
      }
      openEndIndex += 1;
    }
    if (openEndIndex === xml.length) {
      return { status: "incomplete" };
    }
    const openEnd = openEndIndex + 1;
    let slash = openEndIndex - 1;
    while (slash >= nameEnd && /\s/u.test(xml[slash] ?? "")) {
      slash -= 1;
    }
    const openTag = xml.slice(start, openEnd);
    if (xml[slash] === "/") {
      yield {
        start,
        end: openEnd,
        openEnd,
        contentStart: openEnd,
        contentEnd: openEnd,
        name,
        openTag,
        closeTag: "",
        selfClosing: true,
      };
      cursor = openEnd;
      continue;
    }

    const closing = findMatchingClose({ xml, name, openEnd });
    if (closing === null) {
      return { status: "incomplete" };
    }
    yield {
      start,
      end: closing.end,
      openEnd,
      contentStart: openEnd,
      contentEnd: closing.closingStart,
      name,
      openTag,
      closeTag: xml.slice(closing.closingStart, closing.end),
      selfClosing: false,
    };
    cursor = closing.end;
  }
  return { status: "complete" };
};

export const firstXmlElement = (
  xml: string,
  selector: XmlElementSelector,
): FirstXmlElementResult => {
  const result = xmlElements(xml, selector).next();
  if (result.done === true) {
    return result.value.status === "complete"
      ? { kind: "absent" }
      : { kind: "incomplete" };
  }
  return { kind: "found", match: result.value };
};

export const xmlElementText = (xml: string, name: string): string | null => {
  const result = firstXmlElement(xml, name);
  if (result.kind === "absent" || result.kind === "incomplete") {
    return null;
  }
  return result.match.selfClosing
    ? null
    : xml.slice(result.match.contentStart, result.match.contentEnd);
};

export const replaceXmlElements = (
  xml: string,
  selector: XmlElementSelector,
  replace: (match: XmlElementMatch, content: string) => string,
): Result<string, XmlScanError> => {
  const output: string[] = [];
  let cursor = 0;
  const elements = xmlElements(xml, selector);
  let completion: XmlScanCompletion;
  while (true) {
    const next = elements.next();
    if (next.done === true) {
      completion = next.value;
      break;
    }
    const match = next.value;
    output.push(
      xml.slice(cursor, match.start),
      replace(match, xml.slice(match.contentStart, match.contentEnd)),
    );
    cursor = match.end;
  }
  if (completion.status === "incomplete") {
    return Result.err(
      new XmlScanError({ message: "Incomplete matching XML element" }),
    );
  }
  if (cursor === 0) {
    return Result.ok(xml);
  }
  output.push(xml.slice(cursor));
  return Result.ok(output.join(""));
};

export const replaceXmlElementContent = (
  xml: string,
  name: string,
  content: string,
): Result<string, XmlScanError> =>
  replaceXmlElements(xml, name, (match) =>
    match.selfClosing
      ? `${match.openTag.slice(0, match.openTag.lastIndexOf("/")).trimEnd()}>${content}</${match.name}>`
      : `${match.openTag}${content}${match.closeTag}`,
  );

export const clearXmlElements = (
  xml: string,
  names: readonly string[],
): Result<string, XmlScanError> => {
  let result = xml;
  for (const name of names) {
    const replaced = replaceXmlElements(result, name, (match) =>
      match.selfClosing ? match.openTag : `${match.openTag}${match.closeTag}`,
    );
    if (replaced.isErr()) {
      return replaced;
    }
    result = replaced.value;
  }
  return Result.ok(result);
};

export const removeXmlElements = (
  xml: string,
  selector: XmlElementSelector,
  keep?: (element: string) => boolean,
): Result<string, XmlScanError> =>
  replaceXmlElements(xml, selector, (match) => {
    const element = xml.slice(match.start, match.end);
    return keep?.(element) === true ? element : "";
  });
