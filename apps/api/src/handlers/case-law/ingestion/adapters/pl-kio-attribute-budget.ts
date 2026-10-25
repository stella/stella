import { panic } from "better-result";

type TagState =
  | "tag-name"
  | "before-name"
  | "name"
  | "after-name"
  | "before-value"
  | "quoted"
  | "unquoted"
  | "after-quoted"
  | "self-closing";

type AttributeBudget = {
  maxAttributesPerTag: number;
  maxAttributesTotal: number;
  maxScanStepsPerCharacter: number;
};

const isHtmlSpace = (character: string) =>
  character === " " ||
  character === "\t" ||
  character === "\n" ||
  character === "\f" ||
  character === "\r";
const isAsciiLetter = (character: string | undefined) =>
  character !== undefined &&
  ((character >= "a" && character <= "z") ||
    (character >= "A" && character <= "Z"));

/**
 * Every possible tag opener is inspected, even inside comments, values and
 * raw text. Those extra candidates only over-count. Never skip an inner '<':
 * a false candidate's quote state must not hide a real tag's attributes.
 * Overlapping scans share a linear work budget and reject on exhaustion.
 */
export const hasPlKioAttributeBudget = (
  html: string,
  budget: AttributeBudget,
) => {
  let steps = html.length;
  let totalAttributes = 0;
  const maxSteps = html.length * budget.maxScanStepsPerCharacter;
  const scanTag = (start: number) => {
    let state: TagState = "tag-name";
    let quote = "";
    let attributes = 0;
    for (let index = start; index < html.length; index += 1) {
      steps += 1;
      if (steps > maxSteps) {
        return false;
      }
      const character = html.charAt(index);
      if (state === "quoted") {
        if (character === quote) {
          state = "after-quoted";
        }
        continue;
      }
      if (character === ">") {
        return true;
      }
      if (state === "after-quoted" || state === "self-closing") {
        state = "before-name";
      }
      switch (state) {
        case "tag-name":
          if (isHtmlSpace(character)) {
            state = "before-name";
          } else if (character === "/") {
            state = "self-closing";
          }
          break;
        case "before-name":
        case "after-name":
          if (isHtmlSpace(character)) {
            break;
          }
          if (character === "/") {
            state = "self-closing";
            break;
          }
          if (state === "after-name" && character === "=") {
            state = "before-value";
            break;
          }
          attributes += 1;
          totalAttributes += 1;
          if (
            attributes > budget.maxAttributesPerTag ||
            totalAttributes > budget.maxAttributesTotal
          ) {
            return false;
          }
          state = "name";
          break;
        case "name":
          if (isHtmlSpace(character)) {
            state = "after-name";
          } else if (character === "=") {
            state = "before-value";
          } else if (character === "/") {
            state = "self-closing";
          }
          break;
        case "before-value":
          if (isHtmlSpace(character)) {
            break;
          }
          if (character === '"' || character === "'") {
            quote = character;
            state = "quoted";
          } else {
            state = "unquoted";
          }
          break;
        case "unquoted":
          if (isHtmlSpace(character)) {
            state = "before-name";
          }
          break;
        default:
          state satisfies never;
          return panic("Unhandled procurement attribute scan state");
      }
    }
    return true;
  };
  for (let index = 0; index < html.length; index += 1) {
    if (html.charAt(index) !== "<") {
      continue;
    }
    const first = html.at(index + 1);
    const start = first === "/" ? index + 2 : index + 1;
    if (isAsciiLetter(html.at(start)) && !scanTag(start)) {
      return false;
    }
  }
  return true;
};
