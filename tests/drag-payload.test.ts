import { describe, expect, it } from "vitest";
import { parseCardDragPayload, parseColumnDragPayload } from "../drag-payload";

describe("parseCardDragPayload", () => {
  it("parses valid payloads", () => {
    const payload = parseCardDragPayload(
      JSON.stringify({ columnIndex: 1, itemIndex: 3 }),
    );
    expect(payload).toEqual({ columnIndex: 1, itemIndex: 3 });
  });

  it("rejects negative indices", () => {
    const payload = parseCardDragPayload(
      JSON.stringify({ columnIndex: -1, itemIndex: 0 }),
    );
    expect(payload).toBeNull();
  });

  it("rejects invalid JSON", () => {
    expect(parseCardDragPayload("{not valid")).toBeNull();
  });
});

describe("parseColumnDragPayload", () => {
  it("parses valid payloads", () => {
    const payload = parseColumnDragPayload(JSON.stringify({ columnIndex: 2 }));
    expect(payload).toEqual({ columnIndex: 2 });
  });

  it("rejects non-integer indices", () => {
    const payload = parseColumnDragPayload(
      JSON.stringify({ columnIndex: 1.5 }),
    );
    expect(payload).toBeNull();
  });
});
