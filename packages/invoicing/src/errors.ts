import { Result, TaggedError } from "better-result";

export class InvoicingInputError extends TaggedError("InvoicingInputError")<{
  message: string;
}> {}

export type InvoicingResult<T> = Result<T, InvoicingInputError>;

export const invalidInput = (message: string) =>
  Result.err(new InvoicingInputError({ message }));
