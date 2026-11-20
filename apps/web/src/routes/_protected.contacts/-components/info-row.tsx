import { DetailRow } from "@/components/detail-section.pending";

// Read-only row for non-editable fields
export const InfoRow = ({ label, value }: { label: string; value: string }) => (
  <DetailRow label={label}>
    <span className="min-w-0 break-all">{value}</span>
  </DetailRow>
);
