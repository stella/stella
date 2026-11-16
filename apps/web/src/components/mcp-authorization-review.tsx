import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { DetailsGrid, DetailsItem } from "@stll/ui/details-grid";

export const McpAuthorizationReview = ({
  issuer,
  endpointOrigins,
}: {
  issuer: string;
  endpointOrigins: readonly string[];
}) => {
  const t = useTranslations();
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        {t("knowledge.mcp.authorizationReviewDescription")}
      </p>
      <DetailsGrid orientation="vertical" variant="list">
        <DetailsItem label={t("knowledge.mcp.authorizationServer")}>
          <BidiText className="break-all">{issuer}</BidiText>
        </DetailsItem>
        <DetailsItem label={t("knowledge.mcp.endpointOrigins")}>
          <ul className="flex flex-col gap-1">
            {endpointOrigins.map((origin) => (
              <li className="break-all" key={origin}>
                <BidiText>{origin}</BidiText>
              </li>
            ))}
          </ul>
        </DetailsItem>
      </DetailsGrid>
    </div>
  );
};
