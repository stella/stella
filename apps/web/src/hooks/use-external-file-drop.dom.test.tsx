import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

type DropTargetRegistration = {
  element: HTMLElement;
  onDragEnter: () => void;
  onDrop: (args: {
    location: { current: { dropTargets: { element: HTMLElement }[] } };
    self: { element: HTMLElement };
    source: {
      items: { getAsFile: () => File; kind: string }[];
    };
  }) => void;
};

const registrations: DropTargetRegistration[] = [];
let unregisterCount = 0;

await mock.module(
  "@atlaskit/pragmatic-drag-and-drop/adapter/drop-target-for-external",
  () => ({
    dropTargetForExternal: (registration: DropTargetRegistration) => {
      registrations.push(registration);
      return () => {
        unregisterCount += 1;
      };
    },
  }),
);
await mock.module(
  "@atlaskit/pragmatic-drag-and-drop/utils/contains-files",
  () => ({ containsFiles: () => true }),
);
const { createContext, useContext, useRef } = await import("react");
const TranslationContext = createContext<(key: string) => string>((key) => key);
await mock.module("use-intl", () => ({
  useTranslations: () => useContext(TranslationContext),
}));

const { act, cleanup, render } = await import("@testing-library/react");
const { useExternalFileDrop } = await import("@/hooks/use-external-file-drop");

afterEach(() => {
  cleanup();
  registrations.length = 0;
  unregisterCount = 0;
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

type HarnessProps = {
  enabled?: boolean;
  onDrop: (files: File[]) => void;
  translation: (key: string) => string;
};

const Harness = ({ translation, ...props }: HarnessProps) => (
  <TranslationContext value={translation}>
    <DropTarget {...props} />
  </TranslationContext>
);

const DropTarget = ({
  enabled = true,
  onDrop,
}: Omit<HarnessProps, "translation">) => {
  const targetRef = useRef<HTMLDivElement>(null);
  const { isDropTarget } = useExternalFileDrop({
    exceptionScope: { type: "handler", handlerId: "DropTarget.onDrop" },
    enabled,
    externalRef: targetRef,
    onDrop,
  });
  return <div data-active={String(isDropTarget)} ref={targetRef} />;
};

test("a callback and translation rerender keeps the active registration and delivers the drop", async () => {
  const firstDrops: File[][] = [];
  const latestDrops: File[][] = [];
  const view = render(
    <Harness
      onDrop={(files) => {
        firstDrops.push(files);
      }}
      translation={(key) => `first:${key}`}
    />,
  );
  expect(registrations).toHaveLength(1);
  const registration = registrations[0];
  if (!registration) {
    throw new Error("Expected the external drop target to register");
  }
  act(() => registration.onDragEnter());

  view.rerender(
    <Harness
      onDrop={(files) => {
        latestDrops.push(files);
      }}
      translation={(key) => `latest:${key}`}
    />,
  );
  expect(registrations).toHaveLength(1);
  expect(unregisterCount).toBe(0);

  const file = new File(["content"], "evidence.txt");
  await act(async () => {
    registration.onDrop({
      location: {
        current: { dropTargets: [{ element: registration.element }] },
      },
      self: { element: registration.element },
      source: { items: [{ getAsFile: () => file, kind: "file" }] },
    });
    await Promise.resolve();
  });
  expect(firstDrops).toEqual([]);
  expect(latestDrops).toEqual([[file]]);
});

test("tearing down an active registration clears the drop state", () => {
  const view = render(
    <Harness onDrop={() => undefined} translation={(key) => key} />,
  );
  const registration = registrations[0];
  if (!registration) {
    throw new Error("Expected the external drop target to register");
  }
  act(() => registration.onDragEnter());
  expect(view.container.querySelector("div")?.dataset["active"]).toBe("true");

  view.rerender(
    <Harness
      enabled={false}
      onDrop={() => undefined}
      translation={(key) => key}
    />,
  );
  expect(unregisterCount).toBe(1);
  expect(view.container.querySelector("div")?.dataset["active"]).toBe("false");
});
