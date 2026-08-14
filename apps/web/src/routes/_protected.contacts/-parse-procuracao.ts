import { validateRows } from "@/routes/_protected.contacts/-parse-import";
import type {
  ParsedImportFieldKey,
  ParsedImportRow,
  ParsedImportRowFields,
} from "@/routes/_protected.contacts/-parse-import";

export type ProcuracaoCandidate = Record<
  ParsedImportFieldKey,
  string | null
> & {
  contactType: "person" | "organization" | null;
};

const candidateToFields = (
  candidate: ProcuracaoCandidate,
): { fields: ParsedImportRowFields } => ({
  fields: {
    nome: candidate.nome ?? "",
    taxId: candidate.taxId ?? "",
    rg: candidate.rg ?? "",
    nacionalidade: candidate.nacionalidade ?? "",
    estadoCivil: candidate.estadoCivil ?? "",
    uniaoEstavel: candidate.uniaoEstavel ?? "",
    profissao: candidate.profissao ?? "",
    email: candidate.email ?? "",
    endereco: candidate.endereco ?? "",
    contactType: candidate.contactType,
  },
});

// AI-extracted candidates go through the exact same validateRows used for
// parsed .txt rows, so status/warning/error computation stays consistent
// across both import paths — no second implementation.
export const candidatesToRows = (
  candidates: ProcuracaoCandidate[],
): ParsedImportRow[] =>
  validateRows(
    candidates.map((candidate, rowIndex) => ({
      rowIndex,
      ...candidateToFields(candidate),
      blockErrors: [],
      rawLines: [],
    })),
  );
