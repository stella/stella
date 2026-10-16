export const generatedViewsCases = [
  { id: "visualise", prompt: "Visualise the supplied legal analysis." },
  { id: "chart", prompt: "Chart the supplied claim amounts by category." },
  { id: "graph", prompt: "Graph the supplied monthly costs." },
  {
    id: "timeline",
    prompt: "Show a timeline of the supplied procedural events.",
  },
  { id: "diagram", prompt: "Diagram the supplied decision test." },
  { id: "page", prompt: "Show this legal analysis as a page." },
  { id: "nice-html", prompt: "Show the supplied analysis in nice HTML." },
  { id: "cs-visualise", prompt: "Chci toto vizualizovat v hezkém HTML." },
  { id: "cs-chart", prompt: "Ukaž dodané částky jako graf." },
  { id: "cs-overview", prompt: "Vytvoř přehled v HTML z dodaného rozboru." },
  {
    id: "sk-visualise",
    prompt: "Vizualizuj tento právny rozbor v peknom HTML.",
  },
  {
    id: "pl-visualise",
    prompt: "Zwizualizuj tę analizę prawną jako ładną stronę HTML.",
  },
  {
    id: "court-year-treemap",
    prompt:
      "Show the supplied case-law search as a court/year treemap. Use its first-page facets.courtYear distribution; keep citationSum and treatment null and label truncated groups.",
  },
] as const;
