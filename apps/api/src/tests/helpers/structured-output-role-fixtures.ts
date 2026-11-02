import type * as v from "valibot";

import { desktopBillingDraftModelResponseSchema } from "@stll/api-contract/desktop-billing-drafts";

import { analysisOutputSchema } from "@/api/handlers/case-law/analysis/analysis-output";
import { significanceOutputSchema } from "@/api/handlers/case-law/analysis/significance";
import { expansionOutputSchema } from "@/api/handlers/case-law/decisions/search-expand";
import { caseLawRefineOutputSchema } from "@/api/handlers/case-law/decisions/search-refine-query";
import { outputSchema as spanEditOutputSchema } from "@/api/handlers/chat/messages/revisions/span-edit";
import { rewriteOutputSchema } from "@/api/handlers/clauses/rewrite";
import { extractProcuracaoOutputSchema } from "@/api/handlers/contacts/extract-procuracao";
import { proposedPositionsSchema } from "@/api/handlers/document-reviews/reference-position-normalizer";
import {
  generatedSummariesAISchema,
  suggestionsAIOutputSchema,
} from "@/api/handlers/entities/placements/suggest";
import { deriveAskSchema } from "@/api/handlers/playbooks/derive-ask";
import {
  refineSearchOutputSchema,
  searchSummaryOutputSchema,
} from "@/api/handlers/search/ai";
import { aiGenerationSchema } from "@/api/handlers/skills/drafts/generate";
import { aiRevisionSchema } from "@/api/handlers/skills/proposals/from-comments/create";
import { prefillOutputSchema } from "@/api/handlers/templates/prefill";
import { changeSummarySchema } from "@/api/lib/ai-change-summary";
import { bboxOutputSchema } from "@/api/lib/bbox/ai-prompts";
import {
  dispositionSchema,
  formattedTranslationSchema,
  glossarySchema,
  translationSchema as bilingualTranslationSchema,
} from "@/api/lib/bilingual/ai";
import { toSafeId } from "@/api/lib/branded-types";
import {
  buildResearchAnswersSchema,
  type CaseLawResearchColumnContent,
} from "@/api/lib/case-law/research-answers";
import { proposedPartiesSchema } from "@/api/lib/document-review/parties";
import { referenceGradeSchema } from "@/api/lib/document-review/reference-grade";
import { translationSchema as documentTranslationSchema } from "@/api/lib/document-translation/ai";
import { occurrenceRenderingsSchema } from "@/api/lib/docx/ai-field-generator";
import { extractionSchema as claimExtractionSchema } from "@/api/lib/lists/verification/claim-extract";
import { gradingSchema } from "@/api/lib/lists/verification/claim-grade";
import { extractionSchema as memoryExtractionSchema } from "@/api/lib/scheduler/tasks/memory-extractor";
import { deadlineExtractionSchema } from "@/api/lib/scouts/document-deadlines.logic";
import { fieldSuggestionsSchema } from "@/api/lib/templates/suggest-template-fields";
import { buildBatchSchema } from "@/api/lib/workflow/ai-prompts";
import { generativeDecisionsSchema } from "@/api/lib/workflow/decisions/decide";
import { choice, noul } from "@/api/lib/workflow/decisions/system-one";
import type { BatchProperty } from "@/api/lib/workflow/get-execution-plan";
import {
  tierMatchBatchSchema,
  tierMatchSchema,
} from "@/api/lib/workflow/verdict-engine";

const researchYesNo = {
  version: 1,
  type: "single-select",
  options: [
    { color: "green", value: "yes" },
    { color: "red", value: "no" },
  ],
  fallback: null,
} satisfies CaseLawResearchColumnContent;

const batchTool = {
  version: 1,
  type: "ai-model",
  prompt: "Extract it.",
} as const;
const batchProperties: BatchProperty[] = [
  {
    id: toSafeId<"property">("prop-governing-law"),
    status: "stale",
    content: { version: 1, type: "text" },
    dependencies: [],
    tool: batchTool,
  },
  {
    id: toSafeId<"property">("prop-assignment"),
    status: "stale",
    content: {
      version: 1,
      type: "single-select",
      options: [
        { color: "green", value: "Permitted" },
        { color: "red", value: "Prohibited" },
      ],
      fallback: null,
    },
    dependencies: [],
    tool: batchTool,
  },
];
const batchFilenames = [
  {
    original: "supply-agreement.pdf",
    simplified: "F0",
    fileFieldId: toSafeId<"field">("field-contract"),
    kind: "pdf-bates" as const,
  },
];

/**
 * The functions a production role calls to get a structured answer. A file
 * that calls one of them is a structured-output role and needs a fixture for
 * every schema it passes (`structured-output-role-contracts.test.ts`).
 */
export const STRUCTURED_OUTPUT_ENTRY_POINTS = [
  "generateTanStackObjectForTask",
  "streamTanStackObjectForTask",
  "generateTanStackChatObject",
  "createVerificationCall",
] as const;

/**
 * Wrappers that forward their caller's schema rather than owning one, by the
 * expression they forward it as. Their callers are the roles.
 */
export const STRUCTURED_OUTPUT_PASSTHROUGHS: Readonly<
  Record<string, readonly string[]>
> = {
  "lib/docx/ai-field-generator.ts": ["input.outputSchema"],
  "lib/lists/verification/model-call.ts": ["outputSchema"],
};

export type StructuredOutputRoleFixture = {
  /** The calling file, relative to `apps/api/src`. */
  file: string;
  /** The schema argument exactly as the call site writes it. */
  outputSchema: string;
  schema: v.GenericSchema;
  /** A model's answer for the role, as the raw JSON text it streams. */
  answer: string;
};

export const STRUCTURED_OUTPUT_ROLE_FIXTURES: readonly StructuredOutputRoleFixture[] =
  [
    {
      file: "handlers/desktop-time-entries/billing-drafts.ts",
      outputSchema: "desktopBillingDraftModelResponseSchema",
      schema: desktopBillingDraftModelResponseSchema,
      answer:
        '{"drafts":[{"entryId":"entry_1","narrative":"Reviewed the supplied agreement.","classification":{"type":"activity_group","activityGroup":"client"},"flags":[],"matchedEarlierEntryIds":[],"operations":[]}],"checkedGuidelines":[]}',
    },
    {
      file: "handlers/case-law/decisions/search-expand.ts",
      outputSchema: "expansionOutputSchema",
      schema: expansionOutputSchema,
      answer:
        '{"alternatives":[{"term":"kauce","alternatives":["jistota"]},{"term":"nájemník","alternatives":["nájemce"]}]}',
    },
    {
      file: "handlers/case-law/analysis/generate.ts",
      outputSchema: "analysisOutputSchema",
      schema: analysisOutputSchema,
      answer:
        '{"headings":[{"id":"h1","label":"Skutkový stav","category":"facts","startAnchorId":"p1","endAnchorId":"p4","annotations":[{"id":"a1","summary":"Nájemce požadoval vrácení jistoty po skončení nájmu.","startAnchorId":"p2","endAnchorId":"p2","textSnippet":"žalobce se domáhal vrácení jistoty"}]},{"id":"h2","label":"Právní posouzení","category":"reasoning","startAnchorId":"p5","endAnchorId":"p9","annotations":[]}],"holding":[{"text":"Pronajímatel je povinen vrátit jistotu do jednoho měsíce od skončení nájmu, pokud ji nezapočetl proti splatným pohledávkám.","anchors":[{"startAnchorId":"p7","endAnchorId":"p8"}]}],"abstract":[{"text":"Soud rozhodl o nároku nájemce na vrácení jistoty po skončení nájmu bytu a vymezil, kdy může pronajímatel jistotu započíst.","anchors":[]}],"topics":["nájem bytu","jistota","započtení"]}',
    },
    {
      file: "handlers/case-law/analysis/significance-run.ts",
      outputSchema: "significanceOutputSchema",
      schema: significanceOutputSchema,
      answer:
        '{"significance":"Na rozhodnutí odkazuje dvanáct pozdějších rozhodnutí, převážně soudů nižších stupňů, které jeho závěry následují. Negativní čtení se v citacích neobjevuje, takže jde o ustálený a spolehlivý výklad."}',
    },
    {
      file: "handlers/case-law/decisions/search-refine.ts",
      outputSchema: "caseLawRefineOutputSchema",
      schema: caseLawRefineOutputSchema,
      answer: '{"query":"vrácení jistoty pronajímatel"}',
    },
    {
      file: "handlers/chat/messages/revisions/span-edit.ts",
      outputSchema: "outputSchema",
      schema: spanEditOutputSchema,
      answer:
        '{"replacement":"The Supplier shall deliver the Goods within thirty (30) days of the Order Date."}',
    },
    {
      file: "handlers/clauses/rewrite.ts",
      outputSchema: "rewriteOutputSchema",
      schema: rewriteOutputSchema,
      answer:
        '{"paragraphs":[{"index":0,"text":"Either party may terminate this Agreement by giving {{notice_period}} written notice to the other party."},{"index":2,"text":"Termination does not affect any rights that accrued before the termination date."}]}',
    },
    {
      file: "handlers/contacts/extract-procuracao.ts",
      outputSchema: "extractProcuracaoOutputSchema",
      schema: extractProcuracaoOutputSchema,
      answer:
        '{"outorgantes":[{"nome":"Maria Exemplo da Silva","taxId":"000.000.000-00","rg":"00.000.000-0","nacionalidade":"brasileira","estadoCivil":"casada","uniaoEstavel":null,"profissao":"engenheira","email":null,"endereco":"Rua Exemplo, 100, São Paulo/SP","contactType":"person"}]}',
    },
    {
      file: "handlers/document-reviews/reference-positions.ts",
      outputSchema: "proposedPositionsSchema",
      schema: proposedPositionsSchema,
      answer:
        '{"parties":[{"role":"Supplier","name":"Example Supplies Ltd"},{"role":"Customer","name":null}],"positions":[{"termKind":"parameter","issue":"Limitation of liability cap","purpose":"Bounds the supplier\'s exposure for losses under the contract.","guidance":"Compare the cap amount and its multiple of annual fees; a cap below twelve months of fees is a significant concession.","severity":"high","passages":[{"sourceKey":"reference","blockId":"b12"}]}],"skipped":[{"subject":"Delivery address","reason":"deal-specific value"}]}',
    },
    {
      file: "handlers/entities/placements/suggest.ts",
      outputSchema: "generatedSummariesAISchema",
      schema: generatedSummariesAISchema,
      answer:
        '{"summaries":[{"entityId":"ent_01","summary":"Lease agreement for office premises with a five-year term and annual indexation.","language":"en"}]}',
    },
    {
      file: "handlers/entities/placements/suggest.ts",
      outputSchema: "suggestionsAIOutputSchema",
      schema: suggestionsAIOutputSchema,
      answer:
        '{"suggestions":[{"entityId":"ent_01","folderPath":"Contracts/Leases","suggestedName":"Office lease agreement","detectedDate":"2026-03-01","documentType":"Lease agreement"}],"deleteFolders":[{"entityId":"fld_07","reason":"Empty folder left after reorganisation."}]}',
    },
    {
      file: "handlers/playbooks/derive-ask.ts",
      outputSchema: "deriveAskSchema",
      schema: deriveAskSchema,
      answer:
        '{"question":"What is the notice period for termination for convenience?","contentType":"text"}',
    },
    {
      file: "handlers/search/ai.ts",
      outputSchema: "refineSearchOutputSchema",
      schema: refineSearchOutputSchema,
      answer: '{"query":"termination notice lease"}',
    },
    {
      file: "handlers/search/ai.ts",
      outputSchema: "searchSummaryOutputSchema",
      schema: searchSummaryOutputSchema,
      answer:
        '{"title":"Lease termination notice","summary":"The office lease allows termination on six months\' notice [1], and the amendment shortens it to three months for the tenant [2].","citations":[{"number":1,"reason":"States the original notice period."},{"number":2,"reason":"Amends the tenant\'s notice period."}]}',
    },
    {
      file: "handlers/skills/drafts/generate.ts",
      outputSchema: "aiGenerationSchema",
      schema: aiGenerationSchema,
      answer:
        '{"markdown":"---\\nname: nda-review\\ndescription: Review a mutual NDA against the firm\'s standard positions.\\n---\\n\\n# NDA review\\n\\nCheck the term, the definition of confidential information and the carve-outs.","resources":[{"path":"references/nda-positions.md","content":"# Standard positions\\n\\n- Term: at most three years."}]}',
    },
    {
      file: "handlers/skills/proposals/from-comments/create.ts",
      outputSchema: "aiRevisionSchema",
      schema: aiRevisionSchema,
      answer:
        '{"markdown":"---\\nname: nda-review\\ndescription: Review a mutual NDA against the firm\'s standard positions.\\n---\\n\\n# NDA review\\n\\nCheck the term, the definition of confidential information, the carve-outs and the governing law.","summary":"Added governing law to the checklist as the comment asked."}',
    },
    {
      file: "handlers/templates/prefill.ts",
      outputSchema: "prefillOutputSchema",
      schema: prefillOutputSchema,
      answer:
        '{"fields":[{"id":"party_name","value":"Example Holdings s.r.o.","sourceSnippet":"Example Holdings s.r.o., se sídlem"},{"id":"signing_date","value":null,"sourceSnippet":null}]}',
    },
    {
      file: "lib/ai-change-summary.ts",
      outputSchema: "changeSummarySchema",
      schema: changeSummarySchema,
      answer:
        '{"summary":"The notice period in clause 9.2 changed from 30 to 60 days, and a new confidentiality clause was added as clause 14."}',
    },
    {
      file: "lib/bbox/ai-generate-b-boxes.ts",
      outputSchema: "bboxOutputSchema",
      schema: bboxOutputSchema,
      answer:
        '{"boxes":[{"yMin":412,"xMin":88,"yMax":447,"xMax":905},{"yMin":451,"xMin":88,"yMax":472,"xMax":610}]}',
    },
    {
      file: "lib/bilingual/ai.ts",
      outputSchema: "dispositionSchema",
      schema: dispositionSchema,
      answer:
        '{"rows":[{"n":1,"disposition":"translate"},{"n":2,"disposition":"inline"},{"n":3,"disposition":"keep"}]}',
    },
    {
      file: "lib/bilingual/ai.ts",
      outputSchema: "formattedTranslationSchema",
      schema: formattedTranslationSchema,
      answer:
        '{"items":[{"n":4,"spans":[{"id":"s1","text":"The Tenant shall pay the "},{"id":"s2","text":"Rent"},{"id":"s3","text":" monthly in advance."}]}]}',
    },
    {
      file: "lib/bilingual/ai.ts",
      outputSchema: "glossarySchema",
      schema: glossarySchema,
      answer:
        '{"terms":[{"source":"Nájemce","target":"Tenant","sourceForms":["Nájemce","Nájemci","Nájemcem"],"targetForms":["Tenant","Tenants","Tenant\'s"]},{"source":"Nájemné","target":"Rent","sourceForms":["Nájemné","Nájemného"],"targetForms":["Rent"]}]}',
    },
    {
      file: "lib/bilingual/ai.ts",
      outputSchema: "translationSchema",
      schema: bilingualTranslationSchema,
      answer:
        '{"items":[{"n":1,"text":"Article 1 Subject of the Lease"},{"n":2,"text":"The Landlord leases the premises to the Tenant for a fixed term of three years."}]}',
    },
    {
      file: "lib/case-law/research-answer-runner.ts",
      outputSchema: "buildResearchAnswersSchema(generativeQuestions)",
      schema: buildResearchAnswersSchema([
        {
          columnId: "outcome",
          question: "Was the appeal upheld?",
          content: researchYesNo,
        },
        {
          columnId: "holding",
          question: "What did the court hold on the security deposit?",
          content: { version: 1, type: "text" },
        },
      ]),
      answer:
        '{"outcome":{"answer":"no","rationale":"The court dismissed the appeal as unfounded.","anchorIds":["p-12"]},"holding":{"answer":"The landlord must return the deposit once the lease ends, less proven claims.","rationale":"The court states the return duty in its reasoning on the deposit.","anchorIds":["p-7","p-8"]}}',
    },
    {
      file: "lib/document-review/parties.ts",
      outputSchema: "proposedPartiesSchema",
      schema: proposedPartiesSchema,
      answer:
        '{"parties":[{"role":"Seller","name":"Northwind Components s.r.o."},{"role":"Purchaser","name":null}]}',
    },
    {
      file: "lib/document-review/reference-grade.ts",
      outputSchema: "referenceGradeSchema",
      schema: referenceGradeSchema,
      answer:
        '{"findings":[{"positionId":"pos-liability-cap","assessment":"different","consensus":"consistent","rationale":"The target caps liability at 50% of the annual fees, while the standard caps it at 100%.","recommendation":"Raise the liability cap to 100% of the annual fees.","impact":"unfavourable","direction":"higher-favours-target-side","delta":{"targetValue":{"text":"50 % of the annual fees","value":50,"unit":"%","blockId":"b-41"},"standardValue":{"text":"100 % of the annual fees","value":100,"unit":"%","blockId":"r-12"},"items":[],"term":"liability cap","inTarget":true,"inStandard":true},"proposedText":"The Supplier\'s aggregate liability shall not exceed 100 % of the annual fees.","targetCitations":[{"blockId":"b-41"}]}]}',
    },
    {
      file: "lib/document-translation/ai.ts",
      outputSchema: "translationSchema",
      schema: documentTranslationSchema,
      answer:
        '{"items":[{"id":"seg-1","text":"[[stella-translation:r1]]The Buyer shall pay the purchase price within 14 days.[[/stella-translation:r1]]"}]}',
    },
    {
      file: "lib/docx/ai-field-generator.ts",
      outputSchema: "occurrenceRenderingsSchema",
      schema: occurrenceRenderingsSchema,
      answer:
        '{"renderings":["Czech law","according to the laws of the Czech Republic"]}',
    },
    {
      file: "lib/lists/verification/claim-extract.ts",
      outputSchema: "extractionSchema",
      schema: claimExtractionSchema,
      answer:
        '{"claims":[{"blockId":"b12","quote":"The goods were delivered to the warehouse on 3 March 2025.","type":"fact","framing":"asserted"},{"blockId":"b14","quote":"To the best of my knowledge, no complaint was raised before April.","type":"fact","framing":"recalled"}]}',
    },
    {
      file: "lib/lists/verification/claim-grade.ts",
      outputSchema: "gradingSchema",
      schema: gradingSchema,
      answer:
        '{"grades":[{"claimId":"c1","verdict":"supported","score":86,"refs":[{"factId":"f3","rel":"supports"}],"conflict":null},{"claimId":"c2","verdict":"nocover","score":null,"refs":[],"conflict":null}]}',
    },
    {
      file: "lib/scheduler/tasks/memory-extractor.ts",
      outputSchema: "extractionSchema",
      schema: memoryExtractionSchema,
      answer:
        '{"candidates":[{"kind":"preference","content":"Prefers contract summaries as short bullet lists with clause references."},{"kind":"fact","content":"The lease in this matter ends on 30 June 2027 with a six-month notice period."}]}',
    },
    {
      file: "lib/scouts/document-deadlines.ts",
      outputSchema: "deadlineExtractionSchema",
      schema: deadlineExtractionSchema,
      answer:
        '{"deadlines":[{"label":"Tenant notice of renewal","dueDate":"2026-12-31","quote":"The Tenant shall notify the Landlord of renewal no later than 31 December 2026.","confidence":0.92}]}',
    },
    {
      file: "lib/templates/suggest-template-fields.ts",
      outputSchema: "fieldSuggestionsSchema",
      schema: fieldSuggestionsSchema,
      answer:
        '{"suggestions":[{"literalText":"Northwind Logistics s.r.o.","fieldPath":"principal.name","inputType":"text","label":"Principal name","hint":"Full registered company name","exampleValue":"Northwind Logistics s.r.o.","aiPrompt":null},{"literalText":"15 May 2026","fieldPath":"signing.date","inputType":"date","label":"Signing date","hint":null,"exampleValue":"2026-05-15","aiPrompt":null}]}',
    },
    {
      file: "lib/workflow/ai-generate-batch.ts",
      outputSchema: "buildBatchSchema(chunkProperties, filenames)",
      schema: buildBatchSchema(batchProperties, batchFilenames),
      answer:
        '{"prop-governing-law":{"answer":"Czech law","justification":[{"file":"F0","statements":[{"text":"Clause 18.1 makes the agreement subject to Czech law.","citations":["F0-0011"]}]}]},"prop-assignment":{"answer":"Prohibited","justification":[{"file":"F0","statements":[{"text":"Clause 15.2 bars assignment without prior written consent.","citations":["F0-0009"]}]}]}}',
    },
    {
      file: "lib/workflow/decisions/decide.ts",
      outputSchema: "generativeDecisionsSchema(questions)",
      schema: generativeDecisionsSchema({
        treatment: choice("How does the citing court treat the decision?", {
          followed: null,
          distinguished: null,
          overruled: null,
        }),
        sets_deadline: noul("Does the passage set a deadline?"),
      }),
      answer:
        '{"answers":[{"id":"treatment","answer":{"type":"choice","choice":"followed","probabilities":{"followed":0.82,"distinguished":0.15,"overruled":0.03},"confidence":0.8},"evidence":null},{"id":"sets_deadline","answer":{"type":"noul","noul":0.91},"evidence":"within 15 days of service"}]}',
    },
    {
      file: "lib/workflow/decisions/decide.ts",
      outputSchema: "generativeDecisionsSchema(Object.fromEntries(entries))",
      schema: generativeDecisionsSchema({
        governing_law: choice("Which law governs the contract?", {
          czech: null,
          slovak: null,
          other: null,
        }),
      }),
      answer:
        '{"answers":[{"id":"governing_law","answer":{"type":"refusal"},"evidence":null}]}',
    },
    {
      file: "lib/workflow/verdict-engine.ts",
      outputSchema: "tierMatchSchema",
      schema: tierMatchSchema,
      answer:
        '{"tier":"fallback","rationale":"The cap equals twelve months of fees, which matches the first fallback rather than the ideal of the total contract value.","matched":{"kind":"fallback","rank":0}}',
    },
    {
      file: "lib/workflow/verdict-engine.ts",
      outputSchema: "tierMatchBatchSchema",
      schema: tierMatchBatchSchema,
      answer:
        '{"verdicts":[{"item":1,"tier":"compliant","rationale":"The governing law is Czech law, as the ideal requires."},{"item":2,"tier":"deviation","rationale":"Unlimited liability for indirect damages crosses the first red line.","matched":{"kind":"redLine","rank":0}}]}',
    },
  ];
