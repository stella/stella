import { PreviewSurface } from "./PreviewSurface";
import { PreviewTable } from "./PreviewTable";

// Modeled on the app's review table: documents as rows, AI-extracted fields as
// typed columns. It renders the REAL `FieldValue` from `@stll/workspace-ui`, the
// same component the app's table and its loading skeleton use, so a UX change to
// any cell renderer updates the app and this preview together (no drift). The
// last rows leave the Risk cell `pending`, so the app's loading skeleton appears
// here too.
export const TabularReviewPreview = () => (
  <PreviewSurface title="Review · 24 documents">
    <PreviewTable />
  </PreviewSurface>
);
