import { useCallback, useRef } from "react";

import { useForm } from "@tanstack/react-form";
import { useSelector } from "@tanstack/react-store";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stll/ui/components/button";
import { Field, FieldError, FieldLabel } from "@stll/ui/components/field";
import { Form } from "@stll/ui/components/form";
import { Input } from "@stll/ui/components/input";
import { cn } from "@stll/ui/lib/utils";

import { usePulse } from "@/hooks/use-pulse";
import { toFormErrors } from "@/lib/schema";
import { createSlug } from "@/routes/_protected.organization/-utils";

type OrganizationStepProps = {
  defaultName: string;
  onNext: (data: { name: string; slug: string }) => void;
  onNameChange: (name: string) => void;
};

const makeSchema = (required: string) =>
  v.strictObject({
    name: v.pipe(v.string(), v.trim(), v.nonEmpty(required), v.maxLength(50)),
  });

export const OrganizationStep = ({
  defaultName,
  onNext,
  onNameChange,
}: OrganizationStepProps) => {
  const t = useTranslations();
  const inputRef = useRef<HTMLInputElement>(null);
  const schema = makeSchema(t("common.required"));

  const form = useForm({
    defaultValues: { name: defaultName },
    validators: { onDynamic: schema },
    onSubmit: ({ value }) => {
      const result = v.safeParse(schema, value);
      if (!result.success) {
        return;
      }
      const slug = createSlug(result.output.name);
      onNext({ name: result.output.name, slug });
    },
  });

  const formErrors = useSelector(form.store, (s) => toFormErrors(s.fieldMeta));
  const currentName = useSelector(form.store, (s) => s.values.name);

  const { isPulsing: isInputPulsing, pulse } = usePulse(600);

  const flashInput = useCallback(() => {
    inputRef.current?.focus();
    pulse();
  }, [pulse]);

  return (
    <>
      <h1 className="text-foreground text-3xl font-light tracking-tight">
        {t("onboarding.orgTitle")}
      </h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {t("onboarding.orgSubtitle")}
      </p>
      <Form
        className="mt-8 flex flex-1 flex-col"
        errors={formErrors}
        onSubmit={(e) => {
          e.preventDefault();
          if (!currentName.trim()) {
            flashInput();
            return;
          }
          void form.handleSubmit();
        }}
      >
        <form.Field name="name">
          {(field) => (
            <Field name={field.name}>
              <FieldLabel>{t("onboarding.orgNameLabel")}</FieldLabel>
              <Input
                autoFocus
                className={cn(
                  "transition-shadow",
                  isInputPulsing && "ring-primary ring-2",
                )}
                maxLength={50}
                onBlur={field.handleBlur}
                onChange={(e) => {
                  field.handleChange(e.target.value);
                  onNameChange(e.target.value);
                }}
                placeholder="Smith & Associates"
                ref={inputRef}
                value={field.state.value}
              />
              <FieldError />
            </Field>
          )}
        </form.Field>
        <div className="mt-auto flex items-center justify-end pt-8">
          <Button
            aria-disabled={!currentName.trim() || undefined}
            className={cn(
              !currentName.trim() && "cursor-not-allowed opacity-64",
            )}
            onClick={() => {
              if (!currentName.trim()) {
                flashInput();
              }
            }}
            type="submit"
          >
            {currentName.trim()
              ? t("common.next")
              : t("onboarding.enterTeamName")}
          </Button>
        </div>
      </Form>
    </>
  );
};
