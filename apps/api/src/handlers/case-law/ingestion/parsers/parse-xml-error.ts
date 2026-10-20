import { TaggedError } from "better-result";

export class ParseXmlError extends TaggedError("ParseXmlError")<{
  message: string;
  cause: unknown;
}> {}
