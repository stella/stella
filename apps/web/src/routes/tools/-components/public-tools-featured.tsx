import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { CircleHelpIcon } from "@stll/ui/icons";
import { TruncatedText } from "@stll/ui/truncated-text";

import Tooltip from "@/components/tooltip";
import { contractReview } from "@/routes/tools/-components/public-tools-featured-data.logic";
import { PublicToolsFeaturedFace } from "@/routes/tools/-components/public-tools-featured.pending";

export function PublicToolsFeatured() {
  const t = useTranslations();

  return (
    <PublicToolsFeaturedFace
      author={t("catalogue.by", { author: contractReview.author })}
      help={
        <Tooltip
          className="max-w-72 whitespace-normal"
          content={t("publicTools.discovery.howBody")}
          render={<Button className="min-h-11" type="button" variant="muted" />}
        >
          <CircleHelpIcon />
          {t("publicTools.discovery.howTitle")}
        </Tooltip>
      }
      renderLink={({ children, className, slug }) => (
        <Link
          className={className}
          from="/tools/"
          params={{ slug }}
          to="/tools/$slug"
        >
          {children}
        </Link>
      )}
      renderTruncated={({ children, className }) => (
        <TruncatedText
          className={className}
          lines={2}
          render={<BidiText as="p" />}
        >
          {children}
        </TruncatedText>
      )}
    />
  );
}
