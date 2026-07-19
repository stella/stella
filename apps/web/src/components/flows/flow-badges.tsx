import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/lib/utils";

import {
  FLOW_STATUS_STYLES,
  FLOW_STEP_STATUS_LABEL_KEYS,
  FLOW_RUN_STATUS_LABEL_KEYS,
  FLOW_TRIGGER_TYPE_ICONS,
  FLOW_TRIGGER_TYPE_LABEL_KEYS,
  type FlowRunStatus,
  type FlowStepStatus,
  type FlowTriggerType,
} from "@/components/flows/flow-meta";

const badgeBase =
  "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium";

export const FlowStatusBadge = ({
  status,
  className,
}: {
  status: FlowRunStatus;
  className?: string;
}) => {
  const t = useTranslations();
  return (
    <span className={cn(badgeBase, FLOW_STATUS_STYLES[status], className)}>
      {t(FLOW_RUN_STATUS_LABEL_KEYS[status])}
    </span>
  );
};

export const FlowStepStatusBadge = ({
  status,
  className,
}: {
  status: FlowStepStatus;
  className?: string;
}) => {
  const t = useTranslations();
  return (
    <span className={cn(badgeBase, FLOW_STATUS_STYLES[status], className)}>
      {t(FLOW_STEP_STATUS_LABEL_KEYS[status])}
    </span>
  );
};

export const FlowTriggerBadge = ({
  triggerType,
  className,
}: {
  triggerType: FlowTriggerType;
  className?: string;
}) => {
  const t = useTranslations();
  const Icon = FLOW_TRIGGER_TYPE_ICONS[triggerType];
  return (
    <span
      className={cn(
        badgeBase,
        "bg-muted text-muted-foreground border",
        className,
      )}
    >
      <Icon className="size-3" />
      {t(FLOW_TRIGGER_TYPE_LABEL_KEYS[triggerType])}
    </span>
  );
};
