import { describe, expect, it } from "vitest";
import {
  formatWorkbenchHash,
  isNavSectionActive,
  parseWorkbenchHash
} from "./workbenchRoutes.js";

describe("workbench hash routes (todos.dev IA)", () => {
  it("parses chief as home", () => {
    expect(parseWorkbenchHash("")).toEqual({ section: "home" });
    expect(parseWorkbenchHash("#/chief")).toEqual({ section: "home" });
    expect(parseWorkbenchHash("#/home")).toEqual({ section: "home" });
  });

  it("parses inbox and todos panel", () => {
    expect(parseWorkbenchHash("#/inbox")).toEqual({ section: "waiting" });
    expect(parseWorkbenchHash("#/todos")).toEqual({ section: "todos" });
    expect(parseWorkbenchHash("#/todos/todo%2F1")).toEqual({
      section: "todos",
      todoId: "todo/1"
    });
  });

  it("parses panel=todo: on any route", () => {
    expect(parseWorkbenchHash("#/chief?panel=todo:abc")).toEqual({
      section: "home",
      todoId: "abc"
    });
    expect(parseWorkbenchHash("#/resources/providers?panel=todo:xyz")).toEqual({
      section: "connections",
      todoId: "xyz"
    });
  });

  it("parses resources and team", () => {
    expect(parseWorkbenchHash("#/resources/providers")).toEqual({ section: "connections" });
    expect(parseWorkbenchHash("#/resources/skills")).toEqual({ section: "skills" });
    expect(parseWorkbenchHash("#/resources/secrets")).toEqual({ section: "secrets" });
    expect(parseWorkbenchHash("#/app")).toEqual({ section: "team" });
    expect(parseWorkbenchHash("#/agents")).toEqual({ section: "agents" });
    expect(parseWorkbenchHash("#/projects/p1")).toEqual({
      section: "projects",
      projectId: "p1"
    });
  });

  it("formats hashes like todos paths", () => {
    expect(formatWorkbenchHash({ section: "home" })).toBe("#/chief");
    expect(formatWorkbenchHash({ section: "waiting" })).toBe("#/inbox");
    expect(formatWorkbenchHash({ section: "connections" })).toBe("#/resources/providers");
    expect(formatWorkbenchHash({ section: "skills" })).toBe("#/resources/skills");
    expect(formatWorkbenchHash({ section: "team" })).toBe("#/app");
    expect(formatWorkbenchHash({ section: "home", todoId: "t1" })).toBe(
      "#/chief?panel=todo:t1"
    );
    expect(isNavSectionActive({ section: "todos", todoId: "x" }, "todos")).toBe(true);
  });
});
