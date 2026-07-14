import { describe, expect, it } from "vitest";
import {
  formatWorkbenchHash,
  isNavSectionActive,
  parseWorkbenchHash
} from "./workbenchRoutes.js";

describe("workbench hash routes", () => {
  it("parses home and empty hashes", () => {
    expect(parseWorkbenchHash("")).toEqual({ section: "home" });
    expect(parseWorkbenchHash("#")).toEqual({ section: "home" });
    expect(parseWorkbenchHash("#/")).toEqual({ section: "home" });
    expect(parseWorkbenchHash("#/home")).toEqual({ section: "home" });
  });

  it("parses todos list and todo detail", () => {
    expect(parseWorkbenchHash("#/todos")).toEqual({ section: "todos" });
    expect(parseWorkbenchHash("#/todos/todo%2F1")).toEqual({ section: "todos", todoId: "todo/1" });
  });

  it("parses named sections and waiting aliases", () => {
    expect(parseWorkbenchHash("#/projects")).toEqual({ section: "projects" });
    expect(parseWorkbenchHash("#/agents")).toEqual({ section: "agents" });
    expect(parseWorkbenchHash("#/connections")).toEqual({ section: "connections" });
    expect(parseWorkbenchHash("#/settings")).toEqual({ section: "settings" });
    expect(parseWorkbenchHash("#/waiting")).toEqual({ section: "waiting" });
    expect(parseWorkbenchHash("#/waiting-on-me")).toEqual({ section: "waiting" });
  });

  it("falls back to home for unknown paths", () => {
    expect(parseWorkbenchHash("#/unknown-page")).toEqual({ section: "home" });
  });

  it("formats hashes and nav active state", () => {
    expect(formatWorkbenchHash({ section: "home" })).toBe("#/home");
    expect(formatWorkbenchHash({ section: "todos" })).toBe("#/todos");
    expect(formatWorkbenchHash({ section: "todos", todoId: "a/b" })).toBe("#/todos/a%2Fb");
    expect(isNavSectionActive({ section: "todos", todoId: "x" }, "todos")).toBe(true);
    expect(isNavSectionActive({ section: "home" }, "waiting")).toBe(false);
  });
});
