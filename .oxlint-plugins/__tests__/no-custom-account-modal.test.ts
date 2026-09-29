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

  /** A module whose one component renders a dialog around `inside`, after
   *  `before` in the same component body. */
  const dialogAround = (inside: string, before = "") => [
    DIALOG_IMPORT,
    "export const Prompt = () => {",
    before,
    "  return (",
    "    <Dialog open>",
    `      <DialogPopup>${inside}</DialogPopup>`,
    "    </Dialog>",
    "  );",
    "};",
    "",
  ];

  test.each([
    [
      "the shell's sign-in hand-off",
      dialogAround(
        "<Button onClick={() => requestSignIn?.(href)}>Continue</Button>",
        "  const requestSignIn = usePublicSignInRequest();",
      ),
    ],
    [
      "an account-entry message key",
      dialogAround('<DialogTitle>{t("auth.signIn")}</DialogTitle>'),
    ],
    [
      "an account-entry message key as a template literal",
      dialogAround("<DialogTitle>{t(`auth.signIn`)}</DialogTitle>"),
    ],
    [
      "a direct sign-up call",
      dialogAround(
        "<Button onClick={submit}>Continue</Button>",
        "  const submit = () => authClient.signUp.email(input);",
      ),
    ],
    [
      "a link to the sign-in page",
      dialogAround('<Link to="/auth">Continue</Link>'),
    ],
    // The same target spelled as an expression, otherwise identical.
    [
      "a link to the sign-in page in braces",
      dialogAround('<Link to={"/auth"}>Continue</Link>'),
    ],
    [
      "a link to the sign-in page as a template literal",
      dialogAround("<Link to={`/auth`}>Continue</Link>"),
    ],
  ])("reports a modal that reaches %s", async (_signal, lines) => {
    expect(
      await lint([
        'import { usePublicSignInRequest } from "@/components/public-sign-in-request";',
        ...lines,
      ]),
    ).toEqual([2]);
  });

  test.each([
    'import { AlertDialog as Dialog, AlertDialogPopup as DialogPopup } from "@stll/ui/alert-dialog";',
    'import { Sheet as Dialog, SheetPopup as DialogPopup } from "@stll/ui/sheet";',
    'import { Root as Dialog, Popup as DialogPopup } from "@base-ui/react/dialog";',
  ])("treats every modal surface alike: %s", async (modalImport) => {
    expect(
      await lint([
        modalImport,
        "export const Prompt = () => (",
        "  <Dialog open>",
        '    <DialogPopup>{t("auth.createFreeAccount")}</DialogPopup>',
        "  </Dialog>",
        ");",
        "",
      ]),
    ).toEqual([1]);
  });

  test("follows the modal into the same-module parts it renders", async () => {
    expect(
      await lint([
        DIALOG_IMPORT,
        'const SIGN_IN_KEY = "auth.signIn";',
        "const Actions = () => <Button>{t(SIGN_IN_KEY)}</Button>;",
        "export const Prompt = () => (",
        "  <Dialog open>",
        "    <DialogPopup>",
        "      <Actions />",
        "    </DialogPopup>",
        "  </Dialog>",
        ");",
        "",
      ]),
    ).toEqual([1]);
  });

  test("follows the modal up to a parent that hands it the sign-in", async () => {
    expect(
      await lint([
        DIALOG_IMPORT,
        'import { usePublicSignInRequest } from "@/components/public-sign-in-request";',
        "const Prompt = ({ onContinue }: { onContinue: () => void }) => (",
        "  <Dialog open>",
        "    <DialogPopup>",
        "      <Button onClick={onContinue}>Continue</Button>",
        "    </DialogPopup>",
        "  </Dialog>",
        ");",
        "export const Gate = ({ href }: { href: string }) => {",
        "  const requestSignIn = usePublicSignInRequest();",
        "  return <Prompt onContinue={() => requestSignIn?.(href)} />;",
        "};",
        "",
      ]),
    ).toEqual([1]);
  });

  test.each([
    // An inline banner may hand over to the sign-in dialog: it is not a modal.
    [
      [
        'import { usePublicSignInRequest } from "@/components/public-sign-in-request";',
        "export const Banner = () => {",
        "  const requestSignIn = usePublicSignInRequest();",
        '  return <Button onClick={() => requestSignIn?.("/")}>{t("auth.createFreeAccount")}</Button>;',
        "};",
        "",
      ],
    ],
    // Settings dialogs read other `auth.*` keys.
    [dialogAround('<DialogTitle>{t("auth.password")}</DialogTitle>')],
    // A loader redirect is not a navigation the modal offers.
    [
      [
        DIALOG_IMPORT,
        'const guard = () => { throw redirect({ to: "/auth" }); };',
        "export const Sheet = () => <Dialog open><DialogPopup /></Dialog>;",
        "",
      ],
    ],
    // A deeper auth route is not the sign-in page.
    [dialogAround('<Link to="/auth/organization" />')],
    [dialogAround('<Link to={"/auth/organization"} />')],
    // A local object that happens to be named `signIn` elsewhere.
    [dialogAround("<Button onClick={() => session.signIn()} />")],
    // An ordinary dialog beside an unrelated sign-in link in the same module.
    [
      [
        DIALOG_IMPORT,
        'export const SignInLink = () => <Link to="/auth">{t("auth.signIn")}</Link>;',
        "export const FeedbackDialog = () => (",
        "  <Dialog open>",
        "    <DialogPopup>",
        '      <DialogTitle>{t("feedback.title")}</DialogTitle>',
        "    </DialogPopup>",
        "  </Dialog>",
        ");",
        "export const Page = () => (",
        "  <>",
        "    <SignInLink />",
        "    <FeedbackDialog />",
        "  </>",
        ");",
        "",
      ],
    ],
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
