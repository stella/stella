// Read-only row for non-editable fields
export const InfoRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-baseline gap-2">
    <span className="text-muted-foreground w-32 shrink-0">{label}</span>
    <span className="min-w-0 break-all">{value}</span>
  </div>
);
