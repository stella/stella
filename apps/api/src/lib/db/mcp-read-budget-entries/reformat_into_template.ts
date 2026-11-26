import type { ReadBudgetId } from "../read-budgets";

// Reads by primary key only: the document and the one version it formats,
// that version's fields (bounded by the property limit), and the template
// row; picking a template reads at most the template limit of the
// organisation's tagged templates. The output is written through the
// document-create path every upload takes.
export default [] as const satisfies readonly ReadBudgetId[];
