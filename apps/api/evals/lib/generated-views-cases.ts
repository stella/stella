/** Each case carries the material its prompt calls "supplied"; all data is synthetic. */
export const generatedViewsCases = [
  {
    id: "visualise",
    prompt: "Visualise the supplied legal analysis.",
    context:
      "Synthetic analysis: a supplier claims CZK 1 200 000 for late delivery. Liability is likely (delay proven, no force majeure); the amount is disputed: the contractual penalty of CZK 400 000 is capped at 10 %, damages of CZK 800 000 need proof of loss. Risk: medium. Next step: request delivery logs.",
  },
  {
    id: "chart",
    prompt: "Chart the supplied claim amounts by category.",
    context:
      "Synthetic claim amounts (CZK): penalties 400000; damages 800000; interest 65000; costs 42000.",
  },
  {
    id: "graph",
    prompt: "Graph the supplied monthly costs.",
    context:
      "Synthetic monthly costs (EUR): Jan 1200; Feb 980; Mar 1430; Apr 1100; May 1610; Jun 1250.",
  },
  {
    id: "timeline",
    prompt: "Show a timeline of the supplied procedural events.",
    context:
      "Synthetic procedural events: 2026-01-12 action filed; 2026-02-20 statement of defence; 2026-04-03 first hearing; 2026-05-18 expert appointed; 2026-07-09 first-instance judgment; 2026-08-01 appeal lodged.",
  },
  {
    id: "diagram",
    prompt: "Diagram the supplied decision test.",
    context:
      "Synthetic decision test: (1) Is there a contract? If not, no claim. (2) Was the obligation breached? If not, no claim. (3) Was the breach excused? If yes, no claim. (4) Is loss proven? If not, only the contractual penalty applies; if yes, the penalty plus damages above it.",
  },
  {
    id: "page",
    prompt: "Show this legal analysis as a page.",
    context:
      "Synthetic analysis: a supplier claims CZK 1 200 000 for late delivery. Liability is likely (delay proven, no force majeure); the amount is disputed: the contractual penalty of CZK 400 000 is capped at 10 %, damages of CZK 800 000 need proof of loss. Risk: medium. Next step: request delivery logs.",
  },
  {
    id: "nice-html",
    prompt: "Show the supplied analysis in nice HTML.",
    context:
      "Synthetic analysis: a supplier claims CZK 1 200 000 for late delivery. Liability is likely (delay proven, no force majeure); the amount is disputed: the contractual penalty of CZK 400 000 is capped at 10 %, damages of CZK 800 000 need proof of loss. Risk: medium. Next step: request delivery logs.",
  },
  {
    id: "cs-visualise",
    prompt: "Chci toto vizualizovat v hezkém HTML.",
    context:
      "Syntetický rozbor: dodavatel požaduje 1 200 000 Kč za opožděné dodání. Odpovědnost je pravděpodobná, výše sporná: smluvní pokuta 400 000 Kč, škoda 800 000 Kč vyžaduje prokázání. Riziko: střední.",
  },
  {
    id: "cs-chart",
    prompt: "Ukaž dodané částky jako graf.",
    context:
      "Syntetické částky (Kč): smluvní pokuta 400000; škoda 800000; úroky 65000; náklady 42000.",
  },
  {
    id: "cs-overview",
    prompt: "Vytvoř přehled v HTML z dodaného rozboru.",
    context:
      "Syntetický rozbor: dodavatel požaduje 1 200 000 Kč za opožděné dodání. Odpovědnost je pravděpodobná, výše sporná: smluvní pokuta 400 000 Kč, škoda 800 000 Kč vyžaduje prokázání. Riziko: střední.",
  },
  {
    id: "sk-visualise",
    prompt: "Vizualizuj tento právny rozbor v peknom HTML.",
    context:
      "Syntetický rozbor: dodávateľ žiada 1 200 000 EUR za oneskorené dodanie. Zodpovednosť je pravdepodobná, výška je sporná. Riziko: stredné.",
  },
  {
    id: "pl-visualise",
    prompt: "Zwizualizuj tę analizę prawną jako ładną stronę HTML.",
    context:
      "Syntetyczna analiza: dostawca żąda 1 200 000 PLN za opóźnioną dostawę. Odpowiedzialność jest prawdopodobna, wysokość sporna. Ryzyko: średnie.",
  },
  {
    id: "court-year-treemap",
    prompt:
      "Show the supplied case-law search as a court/year treemap. Use its first-page facets.courtYear distribution; keep citationSum and treatment null and label truncated groups.",
    context: JSON.stringify({
      query: "smluvní pokuta",
      truncated: true,
      facets: {
        courtYear: [
          { court: "Nejvyšší soud", year: 2025, count: 41 },
          { court: "Nejvyšší soud", year: 2026, count: 17 },
          { court: "Krajský soud v Brně", year: 2025, count: 23 },
          { court: "Krajský soud v Brně", year: 2026, count: 9 },
          { court: "Městský soud v Praze", year: 2026, count: 12 },
        ],
      },
    }),
  },
] as const satisfies readonly {
  id: string;
  prompt: string;
  context: string;
}[];
