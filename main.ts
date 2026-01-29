import { Plugin } from "obsidian";

type KanbanItem = {
  status: string;
  text: string;
};

type KanbanColumn = {
  name: string;
  items: string[];
};

type KanbanBoard = {
  columns: KanbanColumn[];
};

const DEFAULT_COLUMN = "Uncategorized";

export default class InlineKanbanPlugin extends Plugin {
  onload(): void {
    this.registerMarkdownCodeBlockProcessor("kanban", (source, el) => {
      const board = parseKanbanSource(source);
      renderKanbanBoard(board, el);
    });
  }
}

function parseKanbanSource(source: string): KanbanBoard {
  const lines = source.split(/\r?\n/);
  const columns: string[] = [];
  const items: KanbanItem[] = [];
  let section: "columns" | "items" | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const columnsInline = /^columns:\s*(.+)$/i.exec(line);
    if (columnsInline) {
      section = "columns";
      columns.push(...splitCommaList(columnsInline[1]));
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
        if (entry) columns.push(entry);
        continue;
      }

      if (section === "items") {
        items.push(parseItemEntry(entry));
        continue;
      }
    }
  }

  const columnMap: Record<string, KanbanColumn> = {};
  const columnOrder: string[] = [];

  const ensureColumn = (name: string): KanbanColumn => {
    const key = normalizeKey(name);
    const existing = columnMap[key];
    if (existing) return existing;
    const column = { name, items: [] };
    columnMap[key] = column;
    columnOrder.push(key);
    return column;
  };

  for (const columnName of columns) {
    ensureColumn(columnName);
  }

  if (Object.keys(columnMap).length === 0) {
    for (const item of items) {
      if (item.status) ensureColumn(item.status);
    }
  }

  if (Object.keys(columnMap).length === 0) {
    ensureColumn(DEFAULT_COLUMN);
  }

  for (const item of items) {
    const statusName = item.status || DEFAULT_COLUMN;
    const column =
      columnMap[normalizeKey(statusName)] ?? ensureColumn(statusName);
    column.items.push(item.text);
  }

  return {
    columns: columnOrder.map((key) => columnMap[key]).filter(Boolean),
  };
}

function parseItemEntry(raw: string): KanbanItem {
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

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function renderKanbanBoard(board: KanbanBoard, container: HTMLElement): void {
  container.classList.add("inline-kanban");
  const boardEl = document.createElement("div");
  boardEl.className = "kanban-board";
  container.appendChild(boardEl);

  if (board.columns.length === 0) {
    const empty = document.createElement("div");
    empty.className = "kanban-empty";
    empty.textContent = "No kanban items found.";
    boardEl.appendChild(empty);
    return;
  }

  for (const column of board.columns) {
    const columnEl = document.createElement("div");
    columnEl.className = "kanban-column";
    boardEl.appendChild(columnEl);

    const header = document.createElement("div");
    header.className = "kanban-column-header";
    header.textContent = column.name;
    columnEl.appendChild(header);

    const list = document.createElement("div");
    list.className = "kanban-column-items";
    columnEl.appendChild(list);
    for (const item of column.items) {
      const card = document.createElement("div");
      card.className = "kanban-card";
      card.textContent = item;
      list.appendChild(card);
    }
  }
}
