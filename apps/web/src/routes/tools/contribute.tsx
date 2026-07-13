import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useId, useState } from "react";

import { createFileRoute } from "@tanstack/react-router";
import { Result } from "better-result";
import { XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  CATALOGUE_COST,
  CATALOGUE_LICENSES,
  CATALOGUE_SETUP,
  PRACTICE_AREAS,
  type CatalogueCost,
  type CatalogueSetup,
} from "@stll/catalogue/schema";
import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import { Label } from "@stll/ui/components/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { Textarea } from "@stll/ui/components/textarea";

import type { TranslationKey } from "@/i18n/types";
import { fetchWithTimeout } from "@/lib/fetch";
import { pageTitle } from "@/lib/page-title";
import { createPublicToolsHead } from "@/lib/public-tools-seo";
import { prettifyPracticeArea } from "@/lib/tools-catalogue";
import {
  deriveSlug,
  evaluateManifest,
  firstCommitShaFromResponse,
  githubCommitsApiUrl,
  githubNewFileUrl,
  normalizeGithubRepo,
  type ContributeFormState,
} from "@/routes/tools/-components/contribute.logic";
import { CopyButton } from "@/routes/tools/-components/copy-button";
import { ToggleChip } from "@/routes/tools/-components/toggle-chip";
import {
  CATALOGUE_CONTRIBUTING_URL,
  CATALOGUE_ENTRIES_URL,
} from "@/routes/tools/-components/tool-detail.logic";

const COMMIT_FETCH_TIMEOUT_MS = 10_000;
const JURISDICTION_INPUT = /^[A-Za-z]{2}$/u;

const COST_LABEL_KEY = {
  free: "catalogue.cost.free",
  paid: "catalogue.cost.paid",
} as const satisfies Record<CatalogueCost, TranslationKey>;

const SETUP_LABEL_KEY = {
  none: "catalogue.setup.none",
  account: "catalogue.setup.account",
  "api-key": "catalogue.setup.apiKey",
} as const satisfies Record<CatalogueSetup, TranslationKey>;

const INITIAL_FORM: ContributeFormState = {
  name: "",
  slug: "",
  description: "",
  author: "",
  authorUrl: "",
  license: "MIT",
  cost: "free",
  setup: "none",
  jurisdictions: [],
  tags: [],
  source: "github",
  repo: "",
  directory: "",
  rev: "",
};

type CommitStatus = "idle" | "loading" | "error";

export const Route = createFileRoute("/tools/contribute")({
  head: () =>
    createPublicToolsHead({
      description: "",
      path: "/tools/contribute",
      title: pageTitle("publicTools.contribute.title"),
      type: "article",
    }),
  component: ContributePage,
});

function ContributePage() {
  const t = useTranslations();

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-lg font-semibold">
            {t("publicTools.contribute.title")}
          </h1>
          <p className="text-muted-foreground text-sm">
            {t("publicTools.contribute.intro")}
          </p>
        </div>

        <AddSkillForm />

        <div className="border-border border-t pt-6">
          <Section title={t("knowledge.sections.prompts.title")}>
            <p>
              <strong className="text-foreground font-medium">
                {t("publicTools.contribute.inTreeTitle")}
              </strong>{" "}
              {t("publicTools.contribute.inTreeBody")}
            </p>
            <p>
              <strong className="text-foreground font-medium">
                {t("publicTools.contribute.githubTitle")}
              </strong>{" "}
              {t("publicTools.contribute.githubBody")}
            </p>
          </Section>
        </div>

        <Section title={t("publicTools.contribute.mcpTitle")}>
          <p>{t("publicTools.contribute.mcpBody")}</p>
        </Section>

        <Section title={t("publicTools.contribute.licenseTitle")}>
          <p>{t("publicTools.contribute.licenseBody")}</p>
        </Section>

        <Section title={t("publicTools.contribute.recommendedTitle")}>
          <p>{t("publicTools.contribute.recommendedBody")}</p>
        </Section>

        <div className="flex flex-wrap gap-3 pt-2">
          <Button
            render={
              <a
                aria-label={t("publicTools.contribute.contributingLink")}
                href={CATALOGUE_CONTRIBUTING_URL}
                rel="noreferrer"
                target="_blank"
              />
            }
            variant="outline"
          >
            {t("publicTools.contribute.contributingLink")}
          </Button>
          <Button
            render={
              <a
                aria-label={t("publicTools.contribute.repoLink")}
                href={CATALOGUE_ENTRIES_URL}
                rel="noreferrer"
                target="_blank"
              />
            }
            variant="outline"
          >
            {t("publicTools.contribute.repoLink")}
          </Button>
        </div>
      </div>
    </main>
  );
}

function AddSkillForm() {
  const t = useTranslations();
  const [form, setForm] = useState<ContributeFormState>(INITIAL_FORM);
  const [slugTouched, setSlugTouched] = useState(false);
  const [jurisdictionInput, setJurisdictionInput] = useState("");
  const [commitStatus, setCommitStatus] = useState<CommitStatus>("idle");

  const { json, valid } = evaluateManifest(form);

  const setName = (name: string) => {
    setForm((prev) => ({
      ...prev,
      name,
      slug: slugTouched ? prev.slug : deriveSlug(name),
    }));
  };

  const toggleTag = (tag: string) => {
    setForm((prev) => ({
      ...prev,
      tags: prev.tags.includes(tag)
        ? prev.tags.filter((value) => value !== tag)
        : [...prev.tags, tag],
    }));
  };

  const addJurisdiction = () => {
    const code = jurisdictionInput.trim().toUpperCase();
    if (!JURISDICTION_INPUT.test(code) || form.jurisdictions.includes(code)) {
      return;
    }
    setForm((prev) => ({
      ...prev,
      jurisdictions: [...prev.jurisdictions, code],
    }));
    setJurisdictionInput("");
  };

  const removeJurisdiction = (code: string) => {
    setForm((prev) => ({
      ...prev,
      jurisdictions: prev.jurisdictions.filter((value) => value !== code),
    }));
  };

  const resolveLatestCommit = async () => {
    const repo = normalizeGithubRepo(form.repo);
    if (!repo) {
      setCommitStatus("error");
      return;
    }
    setCommitStatus("loading");
    const result = await Result.tryPromise(async () => {
      const response = await fetchWithTimeout(githubCommitsApiUrl(repo), {
        headers: { Accept: "application/vnd.github+json" },
        timeoutMs: COMMIT_FETCH_TIMEOUT_MS,
      });
      const payload: unknown = response.ok ? await response.json() : null;
      return { ok: response.ok, payload };
    });
    if (Result.isError(result) || !result.value.ok) {
      setCommitStatus("error");
      return;
    }
    const sha = firstCommitShaFromResponse(result.value.payload);
    if (!sha) {
      setCommitStatus("error");
      return;
    }
    setForm((prev) => ({ ...prev, rev: sha }));
    setCommitStatus("idle");
  };

  return (
    <section className="border-border flex flex-col gap-4 rounded-lg border p-4">
      <h2 className="text-base font-semibold">
        {t("publicTools.contribute.form.title")}
      </h2>
      <p className="text-muted-foreground text-sm">
        {t("publicTools.contribute.form.intro")}
      </p>

      <FormRow
        htmlFor="skill-name"
        label={t("publicTools.contribute.form.name")}
      >
        <Input
          id="skill-name"
          onChange={(event) => setName(event.currentTarget.value)}
          value={form.name}
        />
      </FormRow>

      <FormRow
        hint={t("publicTools.contribute.form.slugHint")}
        htmlFor="skill-slug"
        label={t("publicTools.contribute.form.slugLabel")}
      >
        <Input
          className="font-mono"
          id="skill-slug"
          onChange={(event) => {
            setSlugTouched(true);
            setForm((prev) => ({ ...prev, slug: event.currentTarget.value }));
          }}
          value={form.slug}
        />
      </FormRow>

      <FormRow htmlFor="skill-description" label={t("common.description")}>
        <Textarea
          id="skill-description"
          onChange={(event) =>
            setForm((prev) => ({
              ...prev,
              description: event.currentTarget.value,
            }))
          }
          value={form.description}
        />
      </FormRow>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormRow
          htmlFor="skill-author"
          label={t("publicTools.contribute.form.authorLabel")}
        >
          <Input
            id="skill-author"
            onChange={(event) =>
              setForm((prev) => ({
                ...prev,
                author: event.currentTarget.value,
              }))
            }
            value={form.author}
          />
        </FormRow>
        <FormRow
          htmlFor="skill-author-url"
          label={t("publicTools.contribute.form.authorUrlLabel")}
        >
          <Input
            id="skill-author-url"
            onChange={(event) =>
              setForm((prev) => ({
                ...prev,
                authorUrl: event.currentTarget.value,
              }))
            }
            type="url"
            value={form.authorUrl}
          />
        </FormRow>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <FormRow
          htmlFor="skill-license"
          label={t("publicTools.contribute.form.licenseLabel")}
        >
          <Select
            onValueChange={(license) => {
              // Base UI passes null for a cleared single select; these
              // selects are never clearable, so keep the previous value.
              if (license !== null) {
                setForm((prev) => ({ ...prev, license }));
              }
            }}
            value={form.license}
          >
            <SelectTrigger id="skill-license">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {CATALOGUE_LICENSES.map((license) => (
                <SelectItem key={license} value={license}>
                  {license}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </FormRow>
        <FormRow
          htmlFor="skill-cost"
          label={t("publicTools.contribute.form.costLabel")}
        >
          <Select
            onValueChange={(cost) => {
              if (cost !== null) {
                setForm((prev) => ({ ...prev, cost }));
              }
            }}
            value={form.cost}
          >
            <SelectTrigger id="skill-cost">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {CATALOGUE_COST.map((cost) => (
                <SelectItem key={cost} value={cost}>
                  {t(COST_LABEL_KEY[cost])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </FormRow>
        <FormRow
          htmlFor="skill-setup"
          label={t("publicTools.contribute.form.setupLabel")}
        >
          <Select
            onValueChange={(setup) => {
              if (setup !== null) {
                setForm((prev) => ({ ...prev, setup }));
              }
            }}
            value={form.setup}
          >
            <SelectTrigger id="skill-setup">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {CATALOGUE_SETUP.map((setup) => (
                <SelectItem key={setup} value={setup}>
                  {t(SETUP_LABEL_KEY[setup])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </FormRow>
      </div>

      <FormRow
        hint={t("publicTools.contribute.form.jurisdictionsHint")}
        htmlFor="skill-jurisdictions"
        label={t("onboarding.stepJurisdiction")}
      >
        <div className="flex gap-2">
          <Input
            className="font-mono uppercase"
            id="skill-jurisdictions"
            maxLength={2}
            onChange={(event) =>
              setJurisdictionInput(event.currentTarget.value)
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addJurisdiction();
              }
            }}
            placeholder={t(
              "publicTools.contribute.form.jurisdictionPlaceholder",
            )}
            value={jurisdictionInput}
          />
          <Button
            onClick={addJurisdiction}
            size="sm"
            type="button"
            variant="outline"
          >
            {t("common.add")}
          </Button>
        </div>
        {form.jurisdictions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {form.jurisdictions.map((code) => (
              <Button
                className="h-auto gap-1 px-1.5 py-0.5 font-mono text-xs"
                key={code}
                onClick={() => removeJurisdiction(code)}
                size="sm"
                type="button"
                variant="outline"
              >
                {code}
                <XIcon className="size-3" />
              </Button>
            ))}
          </div>
        )}
      </FormRow>

      <FormRow label={t("publicTools.contribute.form.practiceAreasLabel")}>
        <div className="flex flex-wrap gap-1.5">
          {PRACTICE_AREAS.map((tag) => (
            <ToggleChip
              active={form.tags.includes(tag)}
              key={tag}
              onClick={() => toggleTag(tag)}
            >
              {prettifyPracticeArea(tag)}
            </ToggleChip>
          ))}
        </div>
      </FormRow>

      <FormRow label={t("publicTools.contribute.form.sourceLabel")}>
        <div className="flex flex-wrap gap-1.5">
          <SourceChip
            active={form.source === "github"}
            label={t("publicTools.contribute.form.sourceGithub")}
            onSelect={() => setForm((prev) => ({ ...prev, source: "github" }))}
          />
          <SourceChip
            active={form.source === "in-tree"}
            label={t("publicTools.contribute.form.sourceInTree")}
            onSelect={() => setForm((prev) => ({ ...prev, source: "in-tree" }))}
          />
        </div>
        <p className="text-muted-foreground text-xs">
          {form.source === "github"
            ? t("publicTools.contribute.form.sourceGithubHint")
            : t("publicTools.contribute.form.sourceInTreeHint")}
        </p>
      </FormRow>

      {form.source === "github" && (
        <GithubSourceFields
          commitStatus={commitStatus}
          form={form}
          onResolveLatestCommit={() => void resolveLatestCommit()}
          setForm={setForm}
        />
      )}

      {form.source === "in-tree" && (
        <p className="text-muted-foreground text-xs">
          {t("publicTools.contribute.form.inTreeReminder")}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">
            {t("publicTools.contribute.form.manifestPreview")}
          </h3>
          <CopyButton text={json} />
        </div>
        <pre className="bg-muted/40 border-border overflow-x-auto rounded-md border p-3 font-mono text-xs">
          {json}
        </pre>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {valid ? (
          <Button
            render={
              <a
                aria-label={t("publicTools.contribute.form.openPr")}
                href={githubNewFileUrl({
                  slug: form.slug,
                  manifestJson: json,
                })}
                rel="noreferrer"
                target="_blank"
              />
            }
          >
            {t("publicTools.contribute.form.openPr")}
          </Button>
        ) : (
          <Button disabled type="button">
            {t("publicTools.contribute.form.openPr")}
          </Button>
        )}
        {!valid && (
          <p className="text-muted-foreground text-xs">
            {t("publicTools.contribute.form.invalidHint")}
          </p>
        )}
      </div>
    </section>
  );
}

function GithubSourceFields({
  commitStatus,
  form,
  onResolveLatestCommit,
  setForm,
}: {
  commitStatus: CommitStatus;
  form: ContributeFormState;
  onResolveLatestCommit: () => void;
  setForm: Dispatch<SetStateAction<ContributeFormState>>;
}) {
  const t = useTranslations();
  return (
    <div className="flex flex-col gap-4">
      <FormRow
        htmlFor="skill-repo"
        label={t("publicTools.contribute.form.repoLabel")}
      >
        <Input
          className="font-mono"
          id="skill-repo"
          onChange={(event) =>
            setForm((prev) => ({ ...prev, repo: event.currentTarget.value }))
          }
          placeholder={t("publicTools.contribute.form.repoPlaceholder")}
          value={form.repo}
        />
      </FormRow>

      <FormRow
        htmlFor="skill-directory"
        label={t("publicTools.contribute.form.directoryLabel")}
      >
        <Input
          className="font-mono"
          id="skill-directory"
          onChange={(event) =>
            setForm((prev) => ({
              ...prev,
              directory: event.currentTarget.value,
            }))
          }
          placeholder={t("publicTools.contribute.form.directoryPlaceholder")}
          value={form.directory}
        />
      </FormRow>

      <FormRow
        htmlFor="skill-rev"
        label={t("publicTools.contribute.form.revLabel")}
      >
        <div className="flex gap-2">
          <Input
            className="font-mono"
            id="skill-rev"
            onChange={(event) =>
              setForm((prev) => ({ ...prev, rev: event.currentTarget.value }))
            }
            placeholder={t("publicTools.contribute.form.revPlaceholder")}
            value={form.rev}
          />
          <Button
            disabled={commitStatus === "loading"}
            onClick={onResolveLatestCommit}
            size="sm"
            type="button"
            variant="outline"
          >
            {commitStatus === "loading"
              ? t("publicTools.contribute.form.resolvingCommit")
              : t("publicTools.contribute.form.useLatestCommit")}
          </Button>
        </div>
        {commitStatus === "error" && (
          <p className="text-destructive-foreground text-xs">
            {t("publicTools.contribute.form.commitError")}
          </p>
        )}
      </FormRow>
    </div>
  );
}

function SourceChip({
  active,
  label,
  onSelect,
}: {
  active: boolean;
  label: string;
  onSelect: () => void;
}) {
  return (
    <ToggleChip active={active} className="px-2.5 py-1" onClick={onSelect}>
      {label}
    </ToggleChip>
  );
}

function FormRow({
  children,
  hint,
  htmlFor,
  label,
}: {
  children: ReactNode;
  hint?: string;
  htmlFor?: string;
  label: string;
}) {
  const groupLabelId = useId();

  // A single labelable control associates via `htmlFor`. Rows that hold a
  // group of controls (chips, source toggles) have no single target, so
  // the label names a `role="group"` region through `aria-labelledby`
  // rather than orphaning a `<label>` with no `for`.
  if (htmlFor === undefined) {
    return (
      <div className="flex flex-col gap-1.5">
        <Label id={groupLabelId} render={<span />}>
          {label}
        </Label>
        <div aria-labelledby={groupLabelId} role="group">
          {children}
        </div>
        {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="text-muted-foreground flex flex-col gap-2 text-sm leading-relaxed">
        {children}
      </div>
    </section>
  );
}
