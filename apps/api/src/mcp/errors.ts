import { TaggedError } from "better-result";

export class McpAuthenticationError extends TaggedError(
  "McpAuthenticationError",
)<{
  message: string;
  cause?: unknown;
}>() {}

export class McpOrganizationAccessError extends TaggedError(
  "McpOrganizationAccessError",
)<{
  message: string;
}>() {}
