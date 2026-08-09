/** Governed work-obligation lifecycle values shared by the API and clients. */
export const WORK_OBLIGATION_STATUS = {
  UNASSIGNED: "unassigned",
  AWAITING_ACKNOWLEDGEMENT: "awaiting_acknowledgement",
  ACTIVE: "active",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
} as const;

export type WorkObligationStatus =
  (typeof WORK_OBLIGATION_STATUS)[keyof typeof WORK_OBLIGATION_STATUS];

export const WORK_OBLIGATION_STATUSES = Object.freeze([
  WORK_OBLIGATION_STATUS.UNASSIGNED,
  WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
  WORK_OBLIGATION_STATUS.ACTIVE,
  WORK_OBLIGATION_STATUS.COMPLETED,
  WORK_OBLIGATION_STATUS.CANCELLED,
] as const satisfies readonly WorkObligationStatus[]);

export const isWorkObligationStatus = (
  value: unknown,
): value is WorkObligationStatus =>
  typeof value === "string" &&
  WORK_OBLIGATION_STATUSES.some((status) => status === value);
