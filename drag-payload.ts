export type CardDragPayload = {
  columnIndex: number;
  itemIndex: number;
};

export type ColumnDragPayload = {
  columnIndex: number;
};

const isNonNegativeInteger = (value: number): boolean => {
  return Number.isInteger(value) && value >= 0;
};

export function parseCardDragPayload(raw: string): CardDragPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      columnIndex?: unknown;
      itemIndex?: unknown;
    };
    if (typeof parsed.columnIndex !== "number") return null;
    if (typeof parsed.itemIndex !== "number") return null;
    if (!isNonNegativeInteger(parsed.columnIndex)) return null;
    if (!isNonNegativeInteger(parsed.itemIndex)) return null;
    return { columnIndex: parsed.columnIndex, itemIndex: parsed.itemIndex };
  } catch {
    return null;
  }
}

export function parseColumnDragPayload(raw: string): ColumnDragPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { columnIndex?: unknown };
    if (typeof parsed.columnIndex !== "number") return null;
    if (!isNonNegativeInteger(parsed.columnIndex)) return null;
    return { columnIndex: parsed.columnIndex };
  } catch {
    return null;
  }
}
