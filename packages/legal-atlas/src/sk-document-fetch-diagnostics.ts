// Retained until consumers of the Slovak diagnostics migrate to the shared contract.
export {
  DOCUMENT_FETCH_ERROR_KIND as SK_DOCUMENT_FETCH_ERROR_KIND,
  type DocumentFetchErrorKind as SkDocumentFetchErrorKind,
  type DocumentFetchErrorDiagnostic as SkDocumentFetchErrorDiagnostic,
  documentErrorDiagnostics as skDocumentErrorDiagnostics,
  documentResponseDiagnostics as skDocumentResponseDiagnostics,
} from "./document-fetch-diagnostics";
