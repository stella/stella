import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";

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
      <dl className="flex min-w-0 flex-col gap-2 text-sm">
        <dt className="font-medium">
          {t("knowledge.mcp.authorizationServer")}
        </dt>
        <dd className="break-all">
          <BidiText>{issuer}</BidiText>
        </dd>
        <dt className="font-medium">{t("knowledge.mcp.endpointOrigins")}</dt>
        <dd>
          <ul className="flex flex-col gap-1">
            {endpointOrigins.map((origin) => (
              <li className="break-all" key={origin}>
                <BidiText>{origin}</BidiText>
              </li>
            ))}
          </ul>
        </dd>
      </dl>
    </div>
  );
};
