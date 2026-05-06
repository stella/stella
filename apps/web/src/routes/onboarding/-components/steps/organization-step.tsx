import { useCallback, useRef } from "react";

import { Button } from "@stll/ui/components/button";
import { Field, FieldError, FieldLabel } from "@stll/ui/components/field";
import { Form } from "@stll/ui/components/form";
import { Input } from "@stll/ui/components/input";
import { useForm, useStore } from "@tanstack/react-form";
import { useTranslations } from "use-intl";
import * as v from "valibot";

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

  const formErrors = useStore(form.store, (s) => toFormErrors(s.fieldMeta));
  const currentName = useStore(form.store, (s) => s.values.name);

  const flashInput = useCallback(() => {
    const el = inputRef.current;
    if (!el) {
      return;
    }
    el.focus();
    el.classList.add("ring-2", "ring-primary");
    setTimeout(() => {
      el.classList.remove("ring-2", "ring-primary");
    }, 600);
  }, []);

  return (
    <>
      <h1 className="text-foreground text-3xl font-light tracking-tight">
        {t("onboarding.orgTitle")}
      </h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {t("onboarding.orgSubtitle")}
      </p>
      <Form
        className="mt-8"
        errors={formErrors}
        onSubmit={(e) => {
          e.preventDefault();
          if (!currentName.trim()) {
            flashInput();
            return;
          }
          // eslint-disable-next-line typescript/no-floating-promises
          form.handleSubmit();
        }}
      >
        <form.Field name="name">
          {(field) => (
            <Field name={field.name}>
              <FieldLabel>{t("onboarding.orgNameLabel")}</FieldLabel>
              <Input
                autoFocus
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
        <Button
          className="mt-6 w-full"
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
        <p className="text-foreground-muted mt-3 text-center text-xs">
          {t("onboarding.changeAnytime")}
        </p>
      </Form>
    </>
  );
};
