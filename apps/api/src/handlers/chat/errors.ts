import { TaggedError } from "better-result";

export class ChatError extends TaggedError("ChatError")<{
  message: string;
  cause?: unknown;
}>() {}
