type MemorySchedulerAuditOptions = {
  id: string;
  name: string;
  source: string;
};

/** Structured provenance shared by memory scheduler audit writers. */
export const memorySchedulerAuditColumns = ({
  id,
  name,
  source,
}: MemorySchedulerAuditOptions) => ({
  activityCategory: "other" as const,
  approvalStatus: "not_required" as const,
  performerId: id,
  performerName: name,
  performerType: "service" as const,
  triggerSource: source,
  triggerType: "system" as const,
});
