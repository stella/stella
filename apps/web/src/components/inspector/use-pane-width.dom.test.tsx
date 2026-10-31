import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { useState } = await import("react");
const { act, cleanup, fireEvent, render } =
  await import("@testing-library/react");
const { useInspectorPaneWidth } = await import("@stll/ui/inspector");

afterEach(async () => {
  await act(async () => cleanup());
});
afterAll(unregisterDomEnvironment);

const Dock = ({
  hostWidth,
  onWidthChange,
}: {
  hostWidth: number;
  onWidthChange: (width: number) => void;
}) => {
  const { resizeHandleProps } = useInspectorPaneWidth({
    initialWidth: hostWidth,
    onWidthChange,
    sidebarWidth: 240,
    viewportWidth: 1920,
  });
  return <div role="separator" {...resizeHandleProps} />;
};

const remoteWidthLabel = "Remote width";

describe("mounted inspector width", () => {
  test("follows host width updates without persisting them back", () => {
    const onWidthChange = mock<(width: number) => void>();
    const view = render(<Dock hostWidth={320} onWidthChange={onWidthChange} />);
    const handle = view.getByRole("separator");
    expect(handle.getAttribute("aria-valuenow")).toBe("320");

    for (const hostWidth of [520, 610, 400]) {
      view.rerender(
        <Dock hostWidth={hostWidth} onWidthChange={onWidthChange} />,
      );
      expect(handle.getAttribute("aria-valuenow")).toBe(String(hostWidth));
    }
    expect(onWidthChange).not.toHaveBeenCalled();
  });

  test("defers a host update until release and persists the final drag width", () => {
    const onWidthChange = mock<(width: number) => void>();
    const view = render(<Dock hostWidth={320} onWidthChange={onWidthChange} />);
    const handle = view.getByRole("separator");
    Object.defineProperties(handle, {
      setPointerCapture: { value: () => undefined },
      hasPointerCapture: { value: () => false },
    });

    fireEvent.pointerDown(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, {
      pointerId: 1,
      clientX: window.innerWidth - 480,
    });
    expect(handle.getAttribute("aria-valuenow")).toBe("480");
    view.rerender(<Dock hostWidth={610} onWidthChange={onWidthChange} />);
    expect(handle.getAttribute("aria-valuenow")).toBe("480");

    act(() => {
      fireEvent.pointerMove(handle, {
        pointerId: 1,
        clientX: window.innerWidth - 560,
      });
      fireEvent.pointerUp(handle, { pointerId: 1 });
    });
    expect(handle.getAttribute("aria-valuenow")).toBe("610");
    expect(onWidthChange.mock.calls).toEqual([[560]]);

    view.rerender(<Dock hostWidth={420} onWidthChange={onWidthChange} />);
    expect(handle.getAttribute("aria-valuenow")).toBe("420");
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0 });
    expect(handle.getAttribute("aria-valuenow")).toBe("420");
  });

  test("keeps the final drag width when the host acknowledges it on release", () => {
    const persisted = mock<(width: number) => void>();
    const Host = () => {
      const [hostWidth, setHostWidth] = useState(320);
      return (
        <>
          <button type="button" onClick={() => setHostWidth(610)}>
            {remoteWidthLabel}
          </button>
          <Dock
            hostWidth={hostWidth}
            onWidthChange={(width) => {
              persisted(width);
              setHostWidth(width);
            }}
          />
        </>
      );
    };
    const view = render(<Host />);
    const handle = view.getByRole("separator");
    Object.defineProperties(handle, {
      setPointerCapture: { value: () => undefined },
      hasPointerCapture: { value: () => false },
    });
    fireEvent.pointerDown(handle, { pointerId: 1 });
    fireEvent.click(view.getByRole("button", { name: "Remote width" }));
    expect(handle.getAttribute("aria-valuenow")).toBe("320");
    act(() => {
      fireEvent.pointerMove(handle, {
        pointerId: 1,
        clientX: window.innerWidth - 560,
      });
      fireEvent.pointerUp(handle, { pointerId: 1 });
    });
    expect(persisted.mock.calls).toEqual([[560]]);
    expect(handle.getAttribute("aria-valuenow")).toBe("560");
  });
});
