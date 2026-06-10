import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  ListChecksIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@stll/ui/components/dialog";
import { cn } from "@stll/ui/lib/utils";

import type { TranslationKey } from "@/i18n/types";
import { templateCheckOptions } from "@/routes/_protected.knowledge/-queries";

const protectedRouteApi = getRouteApi("/_protected");

type TemplateCheckDialogProps = {
  templateId: string;
};

/**
 * Pre-flight template validation: a self-contained trigger button plus
 * dialog that fetches `GET /templates/:templateId/check` on open and renders
 * the findings grouped errors first, then warnings.
 */
export const TemplateCheckDialog = ({
  templateId,
}: TemplateCheckDialogProps) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const { data, isLoading, isError } = useQuery({
    ...templateCheckOptions(activeOrganizationId, templateId),
    enabled: open,
  });

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <ListChecksIcon className="size-4" />
        {t("templates.checkTemplate")}
      </DialogTrigger>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("templates.checkTemplate")}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          <CheckResults
            findings={data?.findings}
            isError={isError}
            isLoading={isLoading}
          />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common.close")}
          </DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};

// ── Findings ─────────────────────────────────────────

// Mirrors the API's TemplateCheckFinding union; only the fields this dialog
// consumes are typed.
type CheckFinding =
  | {
      code: "structureError";
      severity: "error";
      directive: string;
      paragraphIndex: number;
    }
  | { code: "markerWithoutField"; severity: "warning"; path: string }
  | { code: "unplacedField"; severity: "warning"; path: string }
  | { code: "slotWithoutClause"; severity: "error"; slotName: string }
  | { code: "linkWithoutSlot"; severity: "warning"; slotName: string }
  | { code: "fieldMissingLabel"; severity: "warning"; path: string }
  | { code: "fieldMissingInputType"; severity: "warning"; path: string }
  | { code: "selectWithoutOptions"; severity: "error"; path: string }
  | {
      code: "formulaUnknownPath";
      severity: "error";
      path: string;
      reference: string;
    }
  | {
      code: "conditionUnknownPath";
      severity: "error";
      conditionName: string;
      reference: string;
    };

const FINDING_MESSAGE_KEY = {
  structureError: "templates.checkFindingStructureError",
  markerWithoutField: "templates.checkFindingMarkerWithoutField",
  unplacedField: "templates.checkFindingUnplacedField",
  slotWithoutClause: "templates.checkFindingSlotWithoutClause",
  linkWithoutSlot: "templates.checkFindingLinkWithoutSlot",
  fieldMissingLabel: "templates.checkFindingFieldMissingLabel",
  fieldMissingInputType: "templates.checkFindingFieldMissingInputType",
  selectWithoutOptions: "templates.checkFindingSelectWithoutOptions",
  formulaUnknownPath: "templates.checkFindingFormulaUnknownPath",
  conditionUnknownPath: "templates.checkFindingConditionUnknownPath",
} as const satisfies Record<CheckFinding["code"], TranslationKey>;

/** Stable list key: code + subject + (reference, where one exists) — a
 *  formula/condition can produce several findings for the same subject. */
const findingKey = (finding: CheckFinding): string => {
  const base = `${finding.code}-${findingSubject(finding)}`;
  if (
    finding.code === "formulaUnknownPath" ||
    finding.code === "conditionUnknownPath"
  ) {
    return `${base}-${finding.reference}`;
  }
  return base;
};

/** The marker/field/slot name a finding is about, shown as code. */
const findingSubject = (finding: CheckFinding): string => {
  switch (finding.code) {
    case "structureError":
      return finding.directive;
    case "slotWithoutClause":
    case "linkWithoutSlot":
      return finding.slotName;
    case "conditionUnknownPath":
      return finding.conditionName;
    default:
      return finding.path;
  }
};

type CheckResultsProps = {
  findings: CheckFinding[] | undefined;
  isLoading: boolean;
  isError: boolean;
};

const CheckResults = ({ findings, isLoading, isError }: CheckResultsProps) => {
  const t = useTranslations();

  if (isLoading) {
    return (
      <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
    );
  }
  if (isError || !findings) {
    return (
      <p className="text-destructive-foreground text-sm">
        {t("templates.checkFailed")}
      </p>
    );
  }
  if (findings.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm">
        <CheckCircle2Icon className="text-success size-4 shrink-0" />
        {t("templates.checkNoIssues")}
      </p>
    );
  }

  const errors = findings.filter((finding) => finding.severity === "error");
  const warnings = findings.filter((finding) => finding.severity === "warning");

  return (
    <div className="grid gap-4">
      <FindingGroup
        findings={errors}
        headingKey="templates.checkErrors"
        severity="error"
      />
      <FindingGroup
        findings={warnings}
        headingKey="templates.checkWarnings"
        severity="warning"
      />
    </div>
  );
};

type FindingGroupProps = {
  findings: CheckFinding[];
  headingKey: "templates.checkErrors" | "templates.checkWarnings";
  severity: "error" | "warning";
};

const FindingGroup = ({
  findings,
  headingKey,
  severity,
}: FindingGroupProps) => {
  const t = useTranslations();

  if (findings.length === 0) {
    return null;
  }

  return (
    <section className="grid gap-2">
      <h3 className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
        {t(headingKey, { count: findings.length })}
      </h3>
      <ul className="grid gap-2">
        {findings.map((finding) => (
          <FindingRow
            finding={finding}
            key={findingKey(finding)}
            severity={severity}
          />
        ))}
      </ul>
    </section>
  );
};

type FindingRowProps = {
  finding: CheckFinding;
  severity: "error" | "warning";
};

const FindingRow = ({ finding, severity }: FindingRowProps) => {
  const t = useTranslations();

  let message: string;
  if (finding.code === "structureError") {
    message = t(FINDING_MESSAGE_KEY[finding.code], {
      paragraph: finding.paragraphIndex + 1,
    });
  } else if (
    finding.code === "formulaUnknownPath" ||
    finding.code === "conditionUnknownPath"
  ) {
    message = t(FINDING_MESSAGE_KEY[finding.code], {
      reference: finding.reference,
    });
  } else {
    message = t(FINDING_MESSAGE_KEY[finding.code]);
  }

  const isErrorRow = severity === "error";

  return (
    <li
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
        isErrorRow && "border-destructive/40 bg-destructive/5",
        !isErrorRow && "border-warning/40 bg-warning/5",
      )}
    >
      {isErrorRow ? (
        <AlertCircleIcon className="text-destructive mt-0.5 size-4 shrink-0" />
      ) : (
        <AlertTriangleIcon className="text-warning-foreground mt-0.5 size-4 shrink-0" />
      )}
      <div className="min-w-0">
        <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
          {findingSubject(finding)}
        </code>
        <p className="mt-1">{message}</p>
      </div>
    </li>
  );
};
