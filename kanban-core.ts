export type KanbanItem = {
  status: string;
  text: string;
};

export type KanbanColumn = {
  name: string;
  rawName: string;
  statusName: string;
  wipLimit?: number;
  color?: string;
  items: string[];
};

export type KanbanBoard = {
  columns: KanbanColumn[];
};

export type ColumnDefinition = {
  rawName: string;
  baseName: string;
  wipLimit?: number;
  color?: string;
};

export const DEFAULT_COLUMN = "Uncategorized";

export function parseKanbanSource(source: string): KanbanBoard {
  const lines = source.split(/\r?\n/);
  const columnDefinitions: ColumnDefinition[] = [];
  const items: KanbanItem[] = [];
  let section: "columns" | "items" | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const columnsInline = /^columns:\s*(.+)$/i.exec(line);
    if (columnsInline) {
      section = "columns";
      const entries = splitCommaList(columnsInline[1]);
      for (const entry of entries) {
        const definition = parseColumnDefinition(entry);
        if (definition.rawName) columnDefinitions.push(definition);
      }
      continue;
    }

    if (/^columns:\s*$/i.test(line)) {
      section = "columns";
      continue;
    }

    if (/^items:\s*$/i.test(line)) {
      section = "items";
      continue;
    }

    const listMatch = /^[-*]\s+(.*)$/.exec(line);
    if (listMatch) {
      const entry = listMatch[1].trim();
      if (section === "columns") {
        if (entry) columnDefinitions.push(parseColumnDefinition(entry));
        continue;
      }

      if (section === "items") {
        items.push(parseItemEntry(entry));
        continue;
      }
    }

    if (section === "items" && items.length > 0 && /^\s+/.test(rawLine)) {
      const continuation = line.trim();
      if (continuation) {
        items[items.length - 1].text += `\n${continuation}`;
      }
    }
  }

  const columnMap: Record<string, KanbanColumn> = {};
  const columnOrder: string[] = [];
  const statusUsage = new Map<
    string,
    { rawMatches: number; baseMatches: number }
  >();

  const ensureColumn = (definition: ColumnDefinition): KanbanColumn => {
    const key = normalizeColumnKey(definition.rawName);
    const existing = columnMap[key];
    if (existing) {
      if (!existing.rawName) existing.rawName = definition.rawName;
      if (!existing.name) existing.name = definition.baseName;
      if (existing.wipLimit == null && definition.wipLimit != null) {
        existing.wipLimit = definition.wipLimit;
      }
      if (!existing.color && definition.color) {
        existing.color = definition.color;
      }
      return existing;
    }
    const column = createColumnFromDefinition(definition);
    columnMap[key] = column;
    columnOrder.push(key);
    return column;
  };

  for (const definition of columnDefinitions) {
    ensureColumn(definition);
  }

  if (columnOrder.length === 0) {
    for (const item of items) {
      if (item.status) ensureColumn(parseColumnDefinition(item.status));
    }
  }

  if (columnOrder.length === 0) {
    ensureColumn(parseColumnDefinition(DEFAULT_COLUMN));
  }

  for (const item of items) {
    const statusName = item.status || DEFAULT_COLUMN;
    const key = normalizeColumnKey(statusName);
    const column =
      columnMap[key] ?? ensureColumn(parseColumnDefinition(statusName));
    column.items.push(item.text);

    const usage = statusUsage.get(key) ?? { rawMatches: 0, baseMatches: 0 };
    const trimmedStatus = statusName.trim();
    if (
      trimmedStatus &&
      normalizeKey(trimmedStatus) === normalizeKey(column.rawName)
    ) {
      usage.rawMatches += 1;
    }
    if (
      trimmedStatus &&
      normalizeKey(trimmedStatus) === normalizeKey(column.name)
    ) {
      usage.baseMatches += 1;
    }
    statusUsage.set(key, usage);
  }

  for (const key of columnOrder) {
    const column = columnMap[key];
    const usage = statusUsage.get(key);
    if (usage && usage.rawMatches > 0 && usage.baseMatches === 0) {
      column.statusName = column.rawName;
    } else {
      column.statusName = column.name;
    }
  }

  return {
    columns: columnOrder.map((key) => columnMap[key]).filter(Boolean),
  };
}

export function parseItemEntry(raw: string): KanbanItem {
  let status = "";
  let text = raw.trim();

  const bracketMatch = /^\[(.+?)\]\s*(.*)$/.exec(text);
  if (bracketMatch) {
    status = bracketMatch[1].trim();
    text = bracketMatch[2].trim();
  } else {
    const colonMatch = /^([^:]+):\s*(.*)$/.exec(text);
    if (colonMatch) {
      status = colonMatch[1].trim();
      text = colonMatch[2].trim();
    }
  }

  if (!status) status = DEFAULT_COLUMN;
  if (!text) text = raw.trim();

  return { status, text };
}

function splitCommaList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseColumnDefinition(rawName: string): ColumnDefinition {
  const trimmed = rawName.trim();
  let working = trimmed;
  let color: string | undefined;
  const colorMatch = /^(.*?)(?:\s*\{(#[0-9a-fA-F]{3,8})\})\s*$/.exec(working);
  if (colorMatch) {
    working = colorMatch[1].trim();
    color = normalizeHexColor(colorMatch[2]);
  }
  const match = /^(.*?)(?:\s*\((\d+)\))\s*$/.exec(working);
  if (!match) {
    return { rawName: trimmed, baseName: working || trimmed, color };
  }
  const baseName = match[1].trim();
  const limit = Number(match[2]);
  if (!Number.isFinite(limit)) {
    return { rawName: trimmed, baseName: working || trimmed, color };
  }
  return {
    rawName: trimmed,
    baseName: baseName || working || trimmed,
    wipLimit: limit,
    color,
  };
}

export function createColumnFromDefinition(
  definition: ColumnDefinition,
): KanbanColumn {
  const name = definition.baseName || definition.rawName;
  return {
    name,
    rawName: definition.rawName,
    statusName: name,
    items: [],
    wipLimit: definition.wipLimit,
    color: definition.color,
  };
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeHexColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!/^#[0-9a-f]{3}([0-9a-f]{3})?([0-9a-f]{2})?$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

export function normalizeColumnKey(value: string): string {
  const { baseName } = parseColumnDefinition(value);
  return normalizeKey(baseName || value);
}
