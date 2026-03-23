import { makeObservableProperty } from "@stratasync/core";
import { act, cleanup, render, screen } from "@testing-library/react";
import { configure, observable } from "mobx";
import { observer } from "mobx-react-lite";
import { memo } from "react";

// Allow observable mutations outside actions in tests
// (in the real app, the MobXMap adapter wraps mutations in runInAction)
beforeAll(() => {
  configure({ enforceActions: "never" });
});

/**
 * Minimal Model stub that replicates the MobX property mechanism
 * used by @stratasync/core's Model class + @Property() decorator.
 *
 * Each property has:
 *   - `__data[key]` backing store
 *   - `_mobx[key]` MobX observable.box (lazily created)
 *   - getter reads from box.get() (MobX-tracked)
 *   - setter writes to box.set() (triggers MobX reactions)
 *
 * `_applyUpdate()` writes through the property setter with
 * change tracking suppressed, but the MobX box still fires.
 */
class TestModel {
  _mobx: Record<string, { get(): unknown; set(value: unknown): void }> = {};
  __data: Record<string, unknown> = {};
  private suppressTracking = 0;

  declare id: string;
  declare title: string;
  declare completedAt: number | null;

  changes: {
    name: string;
    oldValue: unknown;
    newValue: unknown;
  }[] = [];

  propertyChanged(name: string, oldValue: unknown, newValue: unknown): void {
    if (this.suppressTracking > 0) {
      return;
    }
    this.changes.push({ name, newValue, oldValue });
  }

  _applyUpdate(changes: Record<string, unknown>): void {
    this.suppressTracking += 1;
    try {
      for (const [key, value] of Object.entries(changes)) {
        const current = this.__data[key];
        if (!Object.is(current, value)) {
          (this as Record<string, unknown>)[key] = value;
          this.__data[key] = value;
        }
      }
    } finally {
      this.suppressTracking -= 1;
    }
  }
}

makeObservableProperty(TestModel.prototype, "id");
makeObservableProperty(TestModel.prototype, "title");
makeObservableProperty(TestModel.prototype, "completedAt");

const createTestItem = (
  overrides: Partial<{
    id: string;
    title: string;
    completedAt: number | null;
  }> = {}
): TestModel => {
  const item = new TestModel();
  item.__data = {
    completedAt: overrides.completedAt ?? null,
    id: overrides.id ?? "item-1",
    title: overrides.title ?? "Test item",
  };
  for (const key of Object.keys(item.__data)) {
    const box = observable.box(item.__data[key]);
    item._mobx[key] = box;
  }
  return item;
};

afterEach(() => {
  cleanup();
});

describe("observer() reactivity with Model property changes", () => {
  it("observer component re-renders when completedAt changes via _applyUpdate", () => {
    const item = createTestItem();
    const renderCount = vi.fn();

    const ObserverComponent = observer(function ChecklistItem({
      item: model,
    }: {
      item: TestModel;
    }) {
      renderCount();
      return (
        <div data-testid="completed">
          {model.completedAt ? "done" : "pending"}
        </div>
      );
    });

    render(<ObserverComponent item={item} />);
    expect(screen.getByTestId("completed").textContent).toBe("pending");
    expect(renderCount).toHaveBeenCalledOnce();

    act(() => {
      item._applyUpdate({ completedAt: Date.now() });
    });

    expect(screen.getByTestId("completed").textContent).toBe("done");
    expect(renderCount).toHaveBeenCalledTimes(2);
  });

  it("observer component re-renders when title changes via _applyUpdate", () => {
    const item = createTestItem({ title: "Original" });
    const renderCount = vi.fn();

    const ObserverComponent = observer(function TitleDisplay({
      item: model,
    }: {
      item: TestModel;
    }) {
      renderCount();
      return <div data-testid="title">{model.title}</div>;
    });

    render(<ObserverComponent item={item} />);
    expect(screen.getByTestId("title").textContent).toBe("Original");
    expect(renderCount).toHaveBeenCalledOnce();

    act(() => {
      item._applyUpdate({ title: "Updated" });
    });

    expect(screen.getByTestId("title").textContent).toBe("Updated");
    expect(renderCount).toHaveBeenCalledTimes(2);
  });

  it("memo component does NOT re-render on in-place property mutation", () => {
    const item = createTestItem();
    const renderCount = vi.fn();

    const MemoComponent = memo(
      function ChecklistItem({ item: model }: { item: TestModel }) {
        renderCount();
        return (
          <div data-testid="completed">
            {model.completedAt ? "done" : "pending"}
          </div>
        );
      },
      (prev, next) => prev.item === next.item
    );

    render(<MemoComponent item={item} />);
    expect(screen.getByTestId("completed").textContent).toBe("pending");
    expect(renderCount).toHaveBeenCalledOnce();

    act(() => {
      item._applyUpdate({ completedAt: Date.now() });
    });

    // memo prevents re-render because prev.item === next.item (same reference)
    expect(screen.getByTestId("completed").textContent).toBe("pending");
    expect(renderCount).toHaveBeenCalledOnce();
  });

  it("observer re-renders only the component that reads the changed property", () => {
    const item = createTestItem({ completedAt: null, title: "Hello" });
    const titleRenderCount = vi.fn();
    const completedRenderCount = vi.fn();

    const TitleComponent = observer(function TitleDisplay({
      item: model,
    }: {
      item: TestModel;
    }) {
      titleRenderCount();
      return <div data-testid="title">{model.title}</div>;
    });

    const CompletedComponent = observer(function CompletedDisplay({
      item: model,
    }: {
      item: TestModel;
    }) {
      completedRenderCount();
      return (
        <div data-testid="completed">
          {model.completedAt ? "done" : "pending"}
        </div>
      );
    });

    render(
      <>
        <TitleComponent item={item} />
        <CompletedComponent item={item} />
      </>
    );

    expect(titleRenderCount).toHaveBeenCalledOnce();
    expect(completedRenderCount).toHaveBeenCalledOnce();

    // Only change completedAt. Title component should NOT re-render.
    act(() => {
      item._applyUpdate({ completedAt: Date.now() });
    });

    expect(screen.getByTestId("completed").textContent).toBe("done");
    expect(screen.getByTestId("title").textContent).toBe("Hello");
    expect(completedRenderCount).toHaveBeenCalledTimes(2);
    expect(titleRenderCount).toHaveBeenCalledOnce();
  });

  it("_applyUpdate suppresses change tracking but still fires MobX boxes", () => {
    const item = createTestItem({ title: "Start" });

    // Direct property write: should track changes
    item.title = "Direct";
    expect(item.changes).toHaveLength(1);
    expect(item.changes[0]).toEqual({
      name: "title",
      newValue: "Direct",
      oldValue: "Start",
    });

    // _applyUpdate: should NOT track changes (suppressTracking)
    item._applyUpdate({ title: "Applied" });
    expect(item.changes).toHaveLength(1);

    // But MobX box should have the new value
    expect(item._mobx.title.get()).toBe("Applied");
    expect(item.title).toBe("Applied");
  });

  it("multiple rapid _applyUpdate calls coalesce into batched re-renders", () => {
    const item = createTestItem({
      completedAt: null,
      title: "Start",
    });
    const renderCount = vi.fn();

    const ObserverComponent = observer(function Display({
      item: model,
    }: {
      item: TestModel;
    }) {
      renderCount();
      return (
        <div>
          <div data-testid="title">{model.title}</div>
          <div data-testid="completed">
            {model.completedAt ? "done" : "pending"}
          </div>
        </div>
      );
    });

    render(<ObserverComponent item={item} />);
    expect(renderCount).toHaveBeenCalledOnce();

    act(() => {
      item._applyUpdate({ title: "Updated" });
      item._applyUpdate({ completedAt: Date.now() });
    });

    expect(screen.getByTestId("title").textContent).toBe("Updated");
    expect(screen.getByTestId("completed").textContent).toBe("done");
    // MobX batches synchronous updates within act()
    expect(renderCount.mock.calls.length).toBeLessThanOrEqual(3);
    expect(renderCount.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
