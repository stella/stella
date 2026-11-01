// The capability catalog the runtime generator derives from the handler graph
// and embeds before any test runs. Tests read these exact entries instead of
// deriving the catalog again, which would load the exporter and the whole
// handler graph into every test process that checks a catalog property.
import catalog from "@/api/mcp/generated/capability-catalog";

export const repositoryCapabilityCatalog: readonly unknown[] = catalog;
