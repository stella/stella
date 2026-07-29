import { TaggedError } from "better-result";

export class OutlookError extends TaggedError("OutlookError")<{
  message: string;
}>() {}
