import { useQuery } from "@tanstack/react-query";
import type { ResolveParams } from "@tanstack/react-router";
import { BookOpenTextIcon } from "lucide-react";

import { BreadcrumbItem } from "@stll/ui/components/breadcrumb";

import { getCourtColor } from "@/lib/court-colors";
import type { SafeId } from "@/lib/safe-id";
import { toSafeId } from "@/lib/safe-id";
import { decisionOptions } from "@/routes/_protected.knowledge/case/-queries/decisions";

type AstBlock = {
  type: string;
  role?: string;
  plainText: string;
};

const extractFullRef = (raw: unknown, fallback: string): string => {
  if (raw === null || raw === undefined) {
    return fallback;
  }
  /* eslint-disable typescript/no-unsafe-type-assertion -- SAFETY: raw is either a JSON string or a parsed AST object from the API */
  const ast =
    typeof raw === "string"
      ? (JSON.parse(raw) as { blocks?: AstBlock[] })
      : (raw as { blocks?: AstBlock[] });
  /* eslint-enable typescript/no-unsafe-type-assertion */
  const block = ast.blocks?.find(
    (b) => b.type === "paragraph" && b.role === "case-number",
  );
  return block?.plainText ?? fallback;
};

const extractId = (param: string): SafeId<"caseLawDecision"> => {
  const sep = param.lastIndexOf("--");
  return toSafeId<"caseLawDecision">(sep !== -1 ? param.slice(sep + 2) : param);
};

export const CaseLawBreadcrumb = ({
  decisionId: rawParam,
}: ResolveParams<"/knowledge/case/$decisionId">) => {
  const { data: decision, isError } = useQuery(
    decisionOptions(extractId(rawParam)),
  );

  if (isError || !decision) {
    return null;
  }

  const color = getCourtColor(decision.court);
  const displayRef = extractFullRef(decision.documentAst, decision.caseNumber);

  return (
    <BreadcrumbItem className="flex items-center gap-1.5">
      <BookOpenTextIcon className="size-3.5 shrink-0" style={{ color }} />
      <span>{decision.court}</span>
      <span className="text-foreground-muted text-sm">{displayRef}</span>
    </BreadcrumbItem>
  );
};
