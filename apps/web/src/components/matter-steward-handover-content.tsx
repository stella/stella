import type { MatterStewardHandoverMatter } from "@stll/api-contract";
import { BidiText } from "@stll/ui/bidi-text";

export const MatterStewardHandoverContent = ({
  matters,
}: {
  matters: readonly MatterStewardHandoverMatter[];
}) => (
  <ul className="space-y-1">
    {matters.map(({ id, name }) => (
      <li key={id}>
        <a
          className="underline underline-offset-2"
          href={`/workspaces/${encodeURIComponent(id)}`}
        >
          <BidiText>{name}</BidiText>
        </a>
      </li>
    ))}
  </ul>
);
