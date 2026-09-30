export type ApprovalFilters = {
  from?: string | undefined;
  to?: string | undefined;
  member?: string | undefined;
  matter?: string | undefined;
};

export const normalizeApprovalFilters = ({
  from,
  to,
  member,
  matter,
}: ApprovalFilters) => ({
  ...(from === undefined ? {} : { from }),
  ...(to === undefined ? {} : { to }),
  ...(member === undefined ? {} : { member }),
  ...(matter === undefined ? {} : { matter }),
});
