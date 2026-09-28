import { TaggedError } from "better-result";

export class InvoicingInputError extends TaggedError("InvoicingInputError")<{
  message: string;
}> {}
