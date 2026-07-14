import { describe, expect, it } from "vitest";
import { todoVisibleInView, type TodoRecord } from "./todos.js";

const archivedTodo: TodoRecord = {
  id: "todo-1",
  title: "恢复测试",
  status: "pending",
  archived: true
};

describe("Todo board view state", () => {
  it("removes a restored Todo from the archived view", () => {
    expect(todoVisibleInView(archivedTodo, { status: "pending", showArchived: true })).toBe(true);
    expect(
      todoVisibleInView({ ...archivedTodo, archived: false }, { status: "pending", showArchived: true })
    ).toBe(false);
  });

  it("only keeps active Todos in their selected work-state view", () => {
    expect(todoVisibleInView({ ...archivedTodo, archived: false }, { status: "pending", showArchived: false })).toBe(true);
    expect(todoVisibleInView({ ...archivedTodo, archived: false, status: "running" }, { status: "pending", showArchived: false })).toBe(false);
  });
});
