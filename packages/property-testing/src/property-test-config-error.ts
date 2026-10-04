import { TaggedError } from "better-result";

export class PropertyTestConfigError extends TaggedError(
  "PropertyTestConfigError",
)<{
  message: string;
  cause?: unknown;
}> {
  constructor(message: string, cause?: unknown) {
    super({ message, cause });
  }
}
