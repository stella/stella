import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const RULE = "no-custom-account-modal";

const lint = async (
  lines: readonly string[],
  sourcePath = "apps/web/src/components/surface.tsx",
) => await lintSingleRule(RULE, lines.join("\n"), { sourcePath });

const DIALOG_IMPORT =
  'import { Dialog, DialogPopup, DialogTitle } from "@stll/ui/dialog";';

/**
 * The intermediate prompt the account gate used to draw in front of the
 * sign-in dialog, trimmed to the parts the rule reads.
 */
const REMOVED_ACCOUNT_GATE_DIALOG = [
  'import { Link, useRouterState } from "@tanstack/react-router";',
  'import { useTranslations } from "use-intl";',
  'import { Button } from "@stll/ui/button";',
  "import {",
  "  Dialog,",
  "  DialogClose,",
  "  DialogDescription,",
  "  DialogFooter,",
  "  DialogHeader,",
  "  DialogPopup,",
  "  DialogTitle,",
  '} from "@stll/ui/dialog";',
  'import { usePublicSignInRequest } from "@/components/public-sign-in-request";',
  "export const RequireAccountDialog = ({ open, onClose }: { open: boolean; onClose: () => void }) => {",
  "  const t = useTranslations();",
  "  const requestSignIn = usePublicSignInRequest();",
  "  const currentHref = useRouterState({ select: (state) => state.location.href });",
  "  return (",
  "    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>",
  "      <DialogPopup>",
  "        <DialogHeader>",
  '          <DialogTitle>{t("auth.requireAccount.generateHeadnotes")}</DialogTitle>',
  '          <DialogDescription>{t("auth.requireAccount.description")}</DialogDescription>',
  "        </DialogHeader>",
  "        <DialogFooter>",
  '          <DialogClose render={<Button variant="ghost" />}>{t("common.cancel")}</DialogClose>',
  "          {requestSignIn === null ? (",
  '            <Button render={<Link search={{ redirectTo: currentHref }} to="/auth" />}>',
  '              {t("auth.createFreeAccount")}',
  "            </Button>",
  "          ) : (",
  "            <Button onClick={() => requestSignIn(currentHref)}>",
  '              {t("auth.createFreeAccount")}',
  "            </Button>",
  "          )}",
  "        </DialogFooter>",
  "      </DialogPopup>",
  "    </Dialog>",
  "  );",
  "};",
  "",
];

describe.serial(RULE, () => {
  test("reports the account gate's removed intermediate dialog once, at its modal import", async () => {
    expect(await lint(REMOVED_ACCOUNT_GATE_DIALOG)).toEqual([4]);
  });

  test.each([
    [
      "the shell's sign-in hand-off",
      'import { usePublicSignInRequest } from "@/components/public-sign-in-request";',
    ],
    ["an account-entry message key", 'const label = t("auth.signIn");'],
    [
      "a direct sign-up call",
      "const submit = () => authClient.signUp.email(input);",
    ],
    [
      "a link to the sign-in page",
      'export const Go = () => <Link to="/auth">x</Link>;',
    ],
  ])("reports a modal that reaches %s", async (_signal, line) => {
    expect(await lint([DIALOG_IMPORT, line, ""])).toEqual([1]);
  });

  test.each([
    'import { AlertDialog } from "@stll/ui/alert-dialog";',
    'import { Sheet } from "@stll/ui/sheet";',
    'import { Dialog } from "@base-ui/react/dialog";',
  ])("treats every modal surface alike: %s", async (modalImport) => {
    expect(
      await lint([
        modalImport,
        'const label = t("auth.createFreeAccount");',
        "",
      ]),
    ).toEqual([1]);
  });

  test.each([
    // An inline banner may hand over to the sign-in dialog: it is not a modal.
    [
      [
        'import { usePublicSignInRequest } from "@/components/public-sign-in-request";',
        'const label = t("auth.createFreeAccount");',
        "",
      ],
    ],
    // Settings dialogs read other `auth.*` keys.
    [[DIALOG_IMPORT, 'const placeholder = t("auth.password");', ""]],
    // A loader redirect is not a navigation the modal offers.
    [
      [
        DIALOG_IMPORT,
        'const guard = () => { throw redirect({ to: "/auth" }); };',
        "",
      ],
    ],
    // A deeper auth route is not the sign-in page.
    [
      [
        DIALOG_IMPORT,
        'export const Go = () => <Link to="/auth/organization" />;',
        "",
      ],
    ],
    // A local object that happens to be named `signIn` elsewhere.
    [[DIALOG_IMPORT, "const run = () => session.signIn();", ""]],
  ])("accepts modules that are not an account modal: %j", async (lines) => {
    expect(await lint(lines)).toEqual([]);
  });

  test("allows the canonical sign-in dialog", async () => {
    expect(
      await lint(
        [DIALOG_IMPORT, 'const title = t("auth.signIn");', ""],
        "apps/web/src/components/auth/sign-in-dialog.tsx",
      ),
    ).toEqual([]);
  });
});
