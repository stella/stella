export const hasMatterCreationCapacity = (
  matters: readonly { status: string }[],
  limit: number,
) => matters.filter(({ status }) => status === "active").length < limit;
