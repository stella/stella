import { TaggedError } from "better-result";

export class Unreachable extends TaggedError("Unreachable")<{
  message: string;
}>() {}

export const unreachable = (message: string): never => {
  throw new Unreachable({ message });
};

export class ParseXmlError extends TaggedError("ParseXmlError")<{
  message: string;
  cause: unknown;
}>() {}

export class ConfigurationError extends TaggedError("ConfigurationError")<{
  message: string;
  cause?: unknown;
}>() {}

export class TelemetryError extends TaggedError("TelemetryError")<{
  message: string;
  cause?: unknown;
}>() {}

export class HealthCheckError extends TaggedError("HealthCheckError")<{
  message: string;
  cause?: unknown;
}>() {}

/** Validation/domain-layer errors: no valid inputs, invalid config. */
export class WorkflowValidationError extends TaggedError(
  "WorkflowValidationError",
)<{
  message: string;
}>() {}

/** Integration-layer errors: AI failures, parse failures, external I/O. */
export class WorkflowIntegrationError extends TaggedError(
  "WorkflowIntegrationError",
)<{
  message: string;
  cause?: unknown;
}>() {}

/** Post-generation OOXML structural violations. */
export class OoxmlValidationError extends TaggedError("OoxmlValidationError")<{
  message: string;
  violations: {
    rule: string;
    message: string;
    element?: string;
  }[];
}>() {}

/** DOCX tracked-changes editing failure. */
export class DocxEditError extends TaggedError("DocxEditError")<{
  message: string;
  cause: unknown;
}>() {}

/** Optimistic-lock failure inside a transaction. */
export class ConcurrentModificationError extends TaggedError(
  "ConcurrentModificationError",
)<{
  message: string;
}>() {}

/** DOCX template block-directive structural errors. */
export class TemplateDirectiveError extends TaggedError(
  "TemplateDirectiveError",
)<{
  message: string;
  errors: {
    message: string;
    paragraphIndex: number;
    directive: string;
  }[];
}>() {}

/** Case-law adapter page-fetch failure. */
export class AdapterFetchError extends TaggedError("AdapterFetchError")<{
  message: string;
  adapterKey: string;
  cursor: string | null;
  httpStatus?: number;
  cause?: unknown;
}>() {}

/** Subprocess execution failure. */
export class SubprocessError extends TaggedError("SubprocessError")<{
  message: string;
  exitCode: number | null;
  cause?: unknown;
}>() {}

/** File content extraction failure. */
export class ExtractionWorkerError extends TaggedError(
  "ExtractionWorkerError",
)<{
  message: string;
  exitCode: number | null;
}>() {}
