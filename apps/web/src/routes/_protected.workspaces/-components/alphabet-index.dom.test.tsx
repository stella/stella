import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import type { WorkspaceGroup } from "@/lib/workspaces/types";

GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });

const { act, cleanup, render } = await import("@testing-library/react");
const { useRef } = await import("react");
const { AlphabetIndex } = await import("./alphabet-index");

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

const SCROLL_HEIGHT = 1000;

const client = (clientName: string): WorkspaceGroup => ({
  type: "client",
  groupId: `group-${clientName}`,
  clientId: `client-${clientName}`,
  clientName,
  responsibleAttorneyName: null,
  workspaces: [],
});

/** The matters list: one header per group, 100px apart. */
const MattersList = ({ groups }: { groups: WorkspaceGroup[] }) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  return (
    <div
      ref={(node) => {
        scrollRef.current = node;
        if (node) {
          Object.defineProperty(node, "scrollHeight", {
            configurable: true,
            value: SCROLL_HEIGHT,
          });
        }
      }}
    >
      {groups.map((group, index) => (
        <h2
          data-group-id={group.groupId}
          key={group.groupId}
          ref={(node) => {
            if (node) {
              Object.defineProperty(node, "offsetTop", {
                configurable: true,
                value: index * 100,
              });
            }
          }}
        >
          {group.groupId}
        </h2>
      ))}
      <AlphabetIndex
        collapsedGroups={[]}
        groups={groups}
        scrollContainerRef={scrollRef}
      />
    </div>
  );
};

const markers = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].map(
    (button) => ({ label: button.textContent, top: button.style.top }),
  );

describe("the client index beside the matters list", () => {
  test("marks the first group of each letter where its header starts", () => {
    const { container } = render(
      <MattersList
        groups={[
          "Alpha",
          "Atlas",
          "Beta",
          "Gamma",
          "Delta",
          "Echo",
          "Foxtrot",
        ].map(client)}
      />,
    );
    expect(markers(container)).toEqual([
      { label: "A", top: "1%" },
      { label: "B", top: "20%" },
      { label: "G", top: "30%" },
      { label: "D", top: "40%" },
      { label: "E", top: "50%" },
      { label: "F", top: "60%" },
    ]);
  });

  test("stays hidden while too few letters are worth an index", () => {
    const { container } = render(
      <MattersList groups={["Alpha", "Beta", "Gamma"].map(client)} />,
    );
    expect(markers(container)).toEqual([]);
    expect(container.querySelector("[hidden]")).not.toBeNull();
  });

  test("a marker takes the list to its group", () => {
    const { container } = render(
      <MattersList
        groups={["Alpha", "Beta", "Gamma", "Delta", "Echo", "Foxtrot"].map(
          client,
        )}
      />,
    );
    const list = container.firstElementChild;
    if (!(list instanceof HTMLElement)) {
      throw new TypeError("the matters list did not render");
    }
    const scrollTo = mock(() => undefined);
    list.scrollTo = scrollTo;
    const delta = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "D",
    );
    act(() => {
      delta?.click();
    });
    expect(scrollTo).toHaveBeenCalledWith({ top: 300, behavior: "instant" });
  });
});
