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

const isNameBoundary = (character: string | undefined): boolean =>
  character === ">" || character === "/" || /\s/u.test(character ?? "");

const matchesSelector = (
  name: string,
  selector: XmlElementSelector,
): boolean =>
  typeof selector === "string"
    ? name === selector
    : name.startsWith(`${selector.prefix}:`);

/**
 * Visits matching XML elements from left to right. An incomplete matching
 * element ends the visit, keeping work proportional to the input length.
 * @yields Each complete matching element.
 */
export const xmlElements = function* (
  xml: string,
  selector: XmlElementSelector,
): Generator<XmlElementMatch> {
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf("<", cursor);
    if (start === -1) {
      return;
    }
    const nameStart = start + 1;
    if (
      xml[nameStart] === "/" ||
      xml[nameStart] === "!" ||
      xml[nameStart] === "?"
    ) {
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
    const openEndIndex = xml.indexOf(">", nameEnd);
    if (openEndIndex === -1) {
      return;
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

    const closingNeedle = `</${name}`;
    let closingStart = xml.indexOf(closingNeedle, openEnd);
    while (
      closingStart !== -1 &&
      !isNameBoundary(xml[closingStart + closingNeedle.length])
    ) {
      closingStart = xml.indexOf(
        closingNeedle,
        closingStart + closingNeedle.length,
      );
    }
    if (closingStart === -1) {
      return;
    }
    const closingEndIndex = xml.indexOf(">", closingStart + name.length + 2);
    if (closingEndIndex === -1) {
      return;
    }
    const end = closingEndIndex + 1;
    yield {
      start,
      end,
      openEnd,
      contentStart: openEnd,
      contentEnd: closingStart,
      name,
      openTag,
      closeTag: xml.slice(closingStart, end),
      selfClosing: false,
    };
    cursor = end;
  }
};

export const firstXmlElement = (
  xml: string,
  selector: XmlElementSelector,
): XmlElementMatch | null => {
  const result = xmlElements(xml, selector).next();
  if (result.done === true) {
    return null;
  }
  return result.value;
};

export const xmlElementText = (xml: string, name: string): string | null => {
  const match = firstXmlElement(xml, name);
  return match === null || match.selfClosing
    ? null
    : xml.slice(match.contentStart, match.contentEnd);
};

export const replaceXmlElements = (
  xml: string,
  selector: XmlElementSelector,
  replace: (match: XmlElementMatch, content: string) => string,
): string => {
  const output: string[] = [];
  let cursor = 0;
  for (const match of xmlElements(xml, selector)) {
    output.push(
      xml.slice(cursor, match.start),
      replace(match, xml.slice(match.contentStart, match.contentEnd)),
    );
    cursor = match.end;
  }
  if (cursor === 0) {
    return xml;
  }
  output.push(xml.slice(cursor));
  return output.join("");
};

export const replaceXmlElementContent = (
  xml: string,
  name: string,
  content: string,
): string =>
  replaceXmlElements(xml, name, (match) =>
    match.selfClosing
      ? `<${name}>${content}</${name}>`
      : `${match.openTag}${content}${match.closeTag}`,
  );

export const clearXmlElements = (
  xml: string,
  names: readonly string[],
): string => {
  let result = xml;
  for (const name of names) {
    result = replaceXmlElements(result, name, (match) =>
      match.selfClosing ? match.openTag : `${match.openTag}${match.closeTag}`,
    );
  }
  return result;
};

export const removeXmlElements = (
  xml: string,
  selector: XmlElementSelector,
  keep?: (element: string) => boolean,
): string =>
  replaceXmlElements(xml, selector, (match) => {
    const element = xml.slice(match.start, match.end);
    return keep?.(element) === true ? element : "";
  });
