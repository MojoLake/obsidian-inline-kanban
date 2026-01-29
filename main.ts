import {
  App,
  MarkdownPostProcessorContext,
  Modal,
  Plugin,
  TFile,
} from "obsidian";

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
    this.registerMarkdownCodeBlockProcessor("kanban", (source, el, ctx) => {
      const board = parseKanbanSource(source);
      const updateBoard = createBoardUpdater(this.app, ctx, el);
      renderKanbanBoard(board, el, updateBoard, this.app);
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

function cloneBoard(board: KanbanBoard): KanbanBoard {
  return {
    columns: board.columns.map((column) => ({
      name: column.name,
      items: [...column.items],
    })),
  };
}

function serializeKanbanBoard(board: KanbanBoard): string {
  const lines: string[] = [];
  lines.push("columns:");
  for (const column of board.columns) {
    lines.push(`  - ${column.name}`);
  }
  lines.push("items:");
  for (const column of board.columns) {
    for (const item of column.items) {
      const text = item.trim();
      if (!text) continue;
      lines.push(`  - [${column.name}] ${text}`);
    }
  }
  return lines.join("\n");
}

function createBoardUpdater(
  app: App,
  ctx: MarkdownPostProcessorContext,
  container: HTMLElement,
): (board: KanbanBoard) => void {
  let queue = Promise.resolve();
  return (board: KanbanBoard) => {
    const source = serializeKanbanBoard(board);
    queue = queue
      .then(() => updateBlockSource(app, ctx, container, source))
      .catch((error) => {
        console.error("Inline Kanban update failed", error);
      });
  };
}

async function updateBlockSource(
  app: App,
  ctx: MarkdownPostProcessorContext,
  container: HTMLElement,
  source: string,
): Promise<void> {
  const section = ctx.getSectionInfo(container);
  if (!section) return;

  const file = app.vault.getAbstractFileByPath(ctx.sourcePath);
  if (!(file instanceof TFile)) return;

  const contents = await app.vault.read(file);
  const lines = contents.split(/\r?\n/);
  const start = section.lineStart;
  const end = section.lineEnd;

  if (start == null || end == null || start >= lines.length) return;

  const openIndex = findOpenFence(lines, start, end);
  const closeIndex = findCloseFence(lines, start, end);
  if (openIndex === -1 || closeIndex === -1 || openIndex >= closeIndex) return;

  const newLines = source ? source.split(/\r?\n/) : [];
  const nextContents = [
    ...lines.slice(0, openIndex + 1),
    ...newLines,
    ...lines.slice(closeIndex),
  ].join("\n");

  if (nextContents !== contents) {
    await app.vault.modify(file, nextContents);
  }
}

function findOpenFence(lines: string[], start: number, end: number): number {
  for (let i = start; i <= end && i < lines.length; i += 1) {
    if (isKanbanFenceLine(lines[i])) return i;
  }
  return -1;
}

function findCloseFence(lines: string[], start: number, end: number): number {
  for (let i = Math.min(end, lines.length - 1); i >= start; i -= 1) {
    if (isFenceLine(lines[i])) return i;
  }
  return -1;
}

function isKanbanFenceLine(line: string): boolean {
  return /^(```|~~~)\s*kanban(\s|$)/i.test(line.trim());
}

function isFenceLine(line: string): boolean {
  return /^(```|~~~)/.test(line.trim());
}

function renderKanbanBoard(
  board: KanbanBoard,
  container: HTMLElement,
  updateBoard: (board: KanbanBoard) => void,
  app: App,
): void {
  container.innerHTML = "";
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

  const rerender = (nextBoard: KanbanBoard): void => {
    renderKanbanBoard(nextBoard, container, updateBoard, app);
  };

  const updateAndRerender = (nextBoard: KanbanBoard): void => {
    updateBoard(nextBoard);
    rerender(nextBoard);
  };

  board.columns.forEach((column, columnIndex) => {
    const columnEl = document.createElement("div");
    columnEl.className = "kanban-column";
    boardEl.appendChild(columnEl);

    const header = document.createElement("div");
    header.className = "kanban-column-header";
    const title = document.createElement("span");
    title.className = "kanban-column-title";
    title.textContent = column.name;
    header.appendChild(title);

    const addButton = document.createElement("button");
    addButton.className = "kanban-add-card";
    addButton.type = "button";
    addButton.textContent = "+";
    addButton.addEventListener("click", () => {
      const modal = new AddCardModal(app, column.name, (text) => {
        const nextBoard = cloneBoard(board);
        nextBoard.columns[columnIndex]?.items.push(text.trim());
        updateAndRerender(nextBoard);
      });
      modal.open();
    });
    header.appendChild(addButton);
    columnEl.appendChild(header);

    const list = document.createElement("div");
    list.className = "kanban-column-items";
    columnEl.appendChild(list);
    const setDragOver = (isOver: boolean): void => {
      list.classList.toggle("is-drag-over", isOver);
    };

    const handleDrop = (event: DragEvent): void => {
      event.preventDefault();
      setDragOver(false);
      const payload = readDragPayload(event);
      if (!payload) return;
      const nextBoard = cloneBoard(board);
      const sourceColumn = nextBoard.columns[payload.columnIndex];
      if (!sourceColumn) return;
      const [moved] = sourceColumn.items.splice(payload.itemIndex, 1);
      if (!moved) return;
      const targetColumn = nextBoard.columns[columnIndex];
      if (!targetColumn) return;
      targetColumn.items.push(moved);
      updateAndRerender(nextBoard);
    };

    columnEl.addEventListener("dragenter", (event) => {
      event.preventDefault();
      setDragOver(true);
    });
    columnEl.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      setDragOver(true);
    });
    columnEl.addEventListener("dragleave", (event) => {
      if (!columnEl.contains(event.relatedTarget as Node | null)) {
        setDragOver(false);
      }
    });
    columnEl.addEventListener("drop", handleDrop);

    column.items.forEach((item, itemIndex) => {
      const card = document.createElement("div");
      card.className = "kanban-card";
      card.textContent = item;
      card.setAttribute("draggable", "true");
      card.addEventListener("dragstart", (event) => {
        if (!event.dataTransfer) return;
        event.dataTransfer.setData(
          "application/x-inline-kanban",
          JSON.stringify({ columnIndex, itemIndex }),
        );
        event.dataTransfer.setData("text/plain", "inline-kanban");
        event.dataTransfer.effectAllowed = "move";
        card.classList.add("is-dragging");
      });
      card.addEventListener("dragend", () => {
        card.classList.remove("is-dragging");
      });
      list.appendChild(card);
    });
  });
}

function readDragPayload(event: DragEvent): {
  columnIndex: number;
  itemIndex: number;
} | null {
  if (!event.dataTransfer) return null;
  const raw =
    event.dataTransfer.getData("application/x-inline-kanban") ||
    event.dataTransfer.getData("text/plain");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      columnIndex: number;
      itemIndex: number;
    };
    if (
      typeof parsed.columnIndex !== "number" ||
      typeof parsed.itemIndex !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

class AddCardModal extends Modal {
  private readonly columnName: string;
  private readonly onSubmit: (text: string) => void;

  constructor(app: App, columnName: string, onSubmit: (text: string) => void) {
    super(app);
    this.columnName = columnName;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", {
      text: `Add card to "${this.columnName}"`,
    });

    const input = contentEl.createEl("input", {
      type: "text",
      cls: "kanban-add-input",
    });
    input.focus();

    const actions = contentEl.createDiv({ cls: "kanban-add-actions" });
    const addButton = actions.createEl("button", { text: "Add" });
    const cancelButton = actions.createEl("button", { text: "Cancel" });

    const submit = (): void => {
      const value = input.value.trim();
      if (!value) return;
      this.onSubmit(value);
      this.close();
    };

    addButton.addEventListener("click", submit);
    cancelButton.addEventListener("click", () => this.close());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
      if (event.key === "Escape") this.close();
    });
  }
}
