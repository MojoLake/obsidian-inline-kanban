import { describe, expect, it } from "vitest";
import { parseColumnDefinition, parseKanbanSource } from "../kanban-core";

describe("parseColumnDefinition", () => {
  it("parses WIP limits", () => {
    const definition = parseColumnDefinition("Doing (3)");
    expect(definition.rawName).toBe("Doing (3)");
    expect(definition.baseName).toBe("Doing");
    expect(definition.wipLimit).toBe(3);
  });

  it("parses column colors", () => {
    const definition = parseColumnDefinition("Review (2) {#ff8800}");
    expect(definition.rawName).toBe("Review (2) {#ff8800}");
    expect(definition.baseName).toBe("Review");
    expect(definition.wipLimit).toBe(2);
    expect(definition.color).toBe("#ff8800");
  });

  it("handles columns without WIP limits", () => {
    const definition = parseColumnDefinition("Backlog");
    expect(definition.rawName).toBe("Backlog");
    expect(definition.baseName).toBe("Backlog");
    expect(definition.wipLimit).toBeUndefined();
  });
});

describe("parseKanbanSource", () => {
  it("maps items into their columns", () => {
    const source = [
      "columns:",
      "  - Todo",
      "  - Doing (2)",
      "items:",
      "  - [Todo] Task A",
      "  - Doing: Task B",
    ].join("\n");
    const board = parseKanbanSource(source);
    expect(board.columns).toHaveLength(2);
    expect(board.columns[0].items).toEqual(["Task A"]);
    expect(board.columns[1].items).toEqual(["Task B"]);
    expect(board.columns[1].wipLimit).toBe(2);
  });

  it("stores column colors", () => {
    const source = [
      "columns:",
      "  - Todo {#3b82f6}",
      "items:",
      "  - [Todo] Task A",
    ].join("\n");
    const board = parseKanbanSource(source);
    expect(board.columns[0].color).toBe("#3b82f6");
  });
});
