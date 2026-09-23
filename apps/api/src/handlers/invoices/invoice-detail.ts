/** The line items an invoice detail read loads with the invoice row. */
export const INVOICE_DETAIL_RELATIONS = {
  timeEntries: {
    columns: {
      id: true,
      workItemId: true,
      dateWorked: true,
      billedMinutes: true,
      rateAtEntry: true,
      currency: true,
      narrative: true,
      invoiceNarrative: true,
      status: true,
    },
    with: { workItem: { columns: { id: true, name: true } } },
  },
  expenses: {
    columns: {
      id: true,
      matterId: true,
      dateIncurred: true,
      amount: true,
      currency: true,
      category: true,
      description: true,
      invoiceDescription: true,
      billable: true,
      markup: true,
    },
    with: { matter: { columns: { id: true, name: true } } },
  },
} as const;
