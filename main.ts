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
const HIGHLIGHT_DURATION_MS = 900;
const pendingColumnHighlights = new Map<
  string,
  { name: string; expiresAt: number }
>();

export default class InlineKanbanPlugin extends Plugin {
  onload(): void {
    this.registerMarkdownCodeBlockProcessor("kanban", (source, el, ctx) => {
      const board = parseKanbanSource(source);
      const updateBoard = createBoardUpdater(this.app, ctx, el);
      const highlightColumnName = getPendingColumnHighlight(ctx.sourcePath);
      renderKanbanBoard(board, el, updateBoard, this.app, {
        highlightColumnName,
      });
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

function setPendingColumnHighlight(path: string, name: string): void {
  if (!path || !name) return;
  pendingColumnHighlights.set(path, {
    name,
    expiresAt: Date.now() + HIGHLIGHT_DURATION_MS,
  });
}

function getPendingColumnHighlight(path: string): string | undefined {
  if (!path) return undefined;
  const entry = pendingColumnHighlights.get(path);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    pendingColumnHighlights.delete(path);
    return undefined;
  }
  return entry.name;
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
): (board: KanbanBoard, highlightColumnName?: string) => void {
  let queue = Promise.resolve();
  return (board: KanbanBoard, highlightColumnName?: string) => {
    if (highlightColumnName) {
      setPendingColumnHighlight(ctx.sourcePath, highlightColumnName);
    }
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

function moveCard(
  board: KanbanBoard,
  fromColumnIndex: number,
  fromItemIndex: number,
  toColumnIndex: number,
  toItemIndex: number,
): void {
  const sourceColumn = board.columns[fromColumnIndex];
  const targetColumn = board.columns[toColumnIndex];
  if (!sourceColumn || !targetColumn) return;

  const [moved] = sourceColumn.items.splice(fromItemIndex, 1);
  if (moved == null) return;

  let insertIndex = toItemIndex;
  if (fromColumnIndex === toColumnIndex && fromItemIndex < toItemIndex) {
    insertIndex -= 1;
  }

  if (insertIndex < 0) insertIndex = 0;
  if (insertIndex > targetColumn.items.length) {
    insertIndex = targetColumn.items.length;
  }

  targetColumn.items.splice(insertIndex, 0, moved);
}

function moveColumn(
  board: KanbanBoard,
  fromIndex: number,
  toIndex: number,
): void {
  const columns = board.columns;
  if (fromIndex < 0 || fromIndex >= columns.length) return;
  if (toIndex < 0) toIndex = 0;
  if (toIndex > columns.length) toIndex = columns.length;

  const [moved] = columns.splice(fromIndex, 1);
  if (!moved) return;

  let insertIndex = toIndex;
  if (fromIndex < toIndex) insertIndex -= 1;
  if (insertIndex < 0) insertIndex = 0;
  if (insertIndex > columns.length) insertIndex = columns.length;

  columns.splice(insertIndex, 0, moved);
}

type RenderOptions = {
  highlightColumnName?: string;
};

function renderKanbanBoard(
  board: KanbanBoard,
  container: HTMLElement,
  updateBoard: (board: KanbanBoard, highlightColumnName?: string) => void,
  app: App,
  options: RenderOptions = {},
): void {
  container.innerHTML = "";
  container.classList.add("inline-kanban");
  const toolbar = document.createElement("div");
  toolbar.className = "kanban-toolbar";
  container.appendChild(toolbar);

  const boardEl = document.createElement("div");
  boardEl.className = "kanban-board";
  container.appendChild(boardEl);

  const dropIndicator = document.createElement("div");
  dropIndicator.className = "kanban-drop-indicator";
  boardEl.appendChild(dropIndicator);

  if (board.columns.length === 0) {
    const empty = document.createElement("div");
    empty.className = "kanban-empty";
    empty.textContent = "No kanban items found.";
    boardEl.appendChild(empty);
    return;
  }

  const rerender = (
    nextBoard: KanbanBoard,
    nextOptions: RenderOptions = {},
  ): void => {
    renderKanbanBoard(nextBoard, container, updateBoard, app, nextOptions);
  };

  const updateAndRerender = (
    nextBoard: KanbanBoard,
    highlightColumnName?: string,
  ): void => {
    updateBoard(nextBoard, highlightColumnName);
    rerender(nextBoard, highlightColumnName ? { highlightColumnName } : {});
  };

  const clearColumnIndicators = (): void => {
    dropIndicator.style.opacity = "0";
  };

  const getColumnDropInfo = (
    clientX: number,
  ): {
    insertIndex: number;
    indicatorLeft: number;
  } | null => {
    const columns = Array.from(
      boardEl.querySelectorAll<HTMLElement>(".kanban-column"),
    );
    if (columns.length === 0) return null;
    const boardRect = boardEl.getBoundingClientRect();

    for (let i = 0; i < columns.length; i += 1) {
      const rect = columns[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) {
        return {
          insertIndex: i,
          indicatorLeft: rect.left - boardRect.left + boardEl.scrollLeft,
        };
      }
    }

    const lastRect = columns[columns.length - 1].getBoundingClientRect();
    return {
      insertIndex: columns.length,
      indicatorLeft: lastRect.right - boardRect.left + boardEl.scrollLeft,
    };
  };

  const showColumnIndicatorAt = (clientX: number): void => {
    const info = getColumnDropInfo(clientX);
    if (!info) return;
    dropIndicator.style.left = `${Math.max(0, info.indicatorLeft - 2)}px`;
    dropIndicator.style.opacity = "1";
  };

  boardEl.addEventListener("dragover", (event) => {
    if (!hasTransferType(event, "application/x-inline-kanban-column")) return;
    event.preventDefault();
    showColumnIndicatorAt(event.clientX);
  });

  boardEl.addEventListener("dragleave", (event) => {
    if (!boardEl.contains(event.relatedTarget as Node | null)) {
      clearColumnIndicators();
    }
  });

  boardEl.addEventListener("drop", (event) => {
    const columnPayload = readColumnDragPayload(event);
    if (!columnPayload) return;
    event.preventDefault();
    clearColumnIndicators();
    const info = getColumnDropInfo(event.clientX);
    if (!info) return;
    const nextBoard = cloneBoard(board);
    const movedName = nextBoard.columns[columnPayload.columnIndex]?.name;
    moveColumn(nextBoard, columnPayload.columnIndex, info.insertIndex);
    updateAndRerender(nextBoard, movedName);
  });

  const addColumnButton = document.createElement("button");
  addColumnButton.className = "kanban-add-column";
  addColumnButton.type = "button";
  addColumnButton.textContent = "Add column";
  addColumnButton.addEventListener("click", () => {
    const modal = new TextPromptModal(app, {
      title: "Add column",
      placeholder: "Column name",
      submitLabel: "Add",
      onSubmit: (value) => {
        const name = value.trim();
        if (!name) return;
        const nextBoard = cloneBoard(board);
        const exists = nextBoard.columns.some(
          (column) => normalizeKey(column.name) === normalizeKey(name),
        );
        if (exists) return;
        nextBoard.columns.push({ name, items: [] });
        updateAndRerender(nextBoard);
      },
    });
    modal.open();
  });
  toolbar.appendChild(addColumnButton);

  const highlightKey = options.highlightColumnName
    ? normalizeKey(options.highlightColumnName)
    : null;

  board.columns.forEach((column, columnIndex) => {
    const columnEl = document.createElement("div");
    columnEl.className = "kanban-column";
    if (highlightKey && normalizeKey(column.name) === highlightKey) {
      columnEl.classList.add("is-column-highlight");
    }
    boardEl.appendChild(columnEl);

    const header = document.createElement("div");
    header.className = "kanban-column-header";

    const dragHandle = document.createElement("button");
    dragHandle.className = "kanban-column-drag-handle";
    dragHandle.type = "button";
    dragHandle.textContent = ":::";
    dragHandle.setAttribute("draggable", "true");
    dragHandle.setAttribute("aria-label", "Reorder column");
    header.appendChild(dragHandle);

    const title = document.createElement("span");
    title.className = "kanban-column-title";
    title.textContent = column.name;
    header.appendChild(title);

    const addButton = document.createElement("button");
    addButton.className = "kanban-add-card";
    addButton.type = "button";
    addButton.textContent = "+";
    addButton.addEventListener("click", () => {
      const modal = new TextPromptModal(app, {
        title: `Add card to "${column.name}"`,
        placeholder: "Card title",
        submitLabel: "Add",
        onSubmit: (text) => {
          const value = text.trim();
          if (!value) return;
          const nextBoard = cloneBoard(board);
          nextBoard.columns[columnIndex]?.items.push(value);
          updateAndRerender(nextBoard);
        },
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
      columnEl.classList.toggle("is-drag-over", isOver);
    };

    dragHandle.addEventListener("dragstart", (event) => {
      if (!event.dataTransfer) return;
      event.dataTransfer.setData(
        "application/x-inline-kanban-column",
        JSON.stringify({ columnIndex }),
      );
      event.dataTransfer.setData("text/plain", "inline-kanban-column");
      event.dataTransfer.effectAllowed = "move";
      columnEl.classList.add("is-column-dragging");
    });
    dragHandle.addEventListener("dragend", () => {
      columnEl.classList.remove("is-column-dragging");
      clearColumnIndicators();
    });

    const handleColumnDrop = (event: DragEvent): void => {
      event.preventDefault();
      setDragOver(false);
      clearColumnIndicators();
      const columnPayload = readColumnDragPayload(event);
      if (columnPayload) {
        event.stopPropagation();
        const nextBoard = cloneBoard(board);
        const info = getColumnDropInfo(event.clientX);
        if (!info) return;
        const movedName = nextBoard.columns[columnPayload.columnIndex]?.name;
        moveColumn(nextBoard, columnPayload.columnIndex, info.insertIndex);
        updateAndRerender(nextBoard, movedName);
        return;
      }

      const payload = readCardDragPayload(event);
      if (!payload) return;
      const nextBoard = cloneBoard(board);
      moveCard(
        nextBoard,
        payload.columnIndex,
        payload.itemIndex,
        columnIndex,
        nextBoard.columns[columnIndex]?.items.length ?? 0,
      );
      updateAndRerender(nextBoard);
    };

    columnEl.addEventListener("dragenter", (event) => {
      event.preventDefault();
      if (hasTransferType(event, "application/x-inline-kanban-card")) {
        setDragOver(true);
      }
    });
    columnEl.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      if (hasTransferType(event, "application/x-inline-kanban-column")) {
        showColumnIndicatorAt(event.clientX);
        setDragOver(false);
        return;
      }

      clearColumnIndicators();
      setDragOver(true);
    });
    columnEl.addEventListener("dragleave", (event) => {
      if (!columnEl.contains(event.relatedTarget as Node | null)) {
        setDragOver(false);
        clearColumnIndicators();
      }
    });
    columnEl.addEventListener("drop", handleColumnDrop);

    column.items.forEach((item, itemIndex) => {
      const card = document.createElement("div");
      card.className = "kanban-card";
      card.textContent = item;
      card.setAttribute("draggable", "true");
      card.addEventListener("dragstart", (event) => {
        if (!event.dataTransfer) return;
        event.dataTransfer.setData(
          "application/x-inline-kanban-card",
          JSON.stringify({ columnIndex, itemIndex }),
        );
        event.dataTransfer.setData("text/plain", "inline-kanban-card");
        event.dataTransfer.effectAllowed = "move";
        card.classList.add("is-dragging");
      });
      card.addEventListener("dragover", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        if (hasTransferType(event, "application/x-inline-kanban-column")) {
          card.classList.remove("is-drag-over");
          return;
        }
        card.classList.add("is-drag-over");
      });
      card.addEventListener("dragleave", () => {
        card.classList.remove("is-drag-over");
      });
      card.addEventListener("drop", (event) => {
        event.preventDefault();
        event.stopPropagation();
        card.classList.remove("is-drag-over");
        setDragOver(false);
        clearColumnIndicators();
        const columnPayload = readColumnDragPayload(event);
        if (columnPayload) {
          const nextBoard = cloneBoard(board);
          const info = getColumnDropInfo(event.clientX);
          if (!info) return;
          const movedName = nextBoard.columns[columnPayload.columnIndex]?.name;
          moveColumn(nextBoard, columnPayload.columnIndex, info.insertIndex);
          updateAndRerender(nextBoard, movedName);
          return;
        }

        const payload = readCardDragPayload(event);
        if (!payload) return;
        const nextBoard = cloneBoard(board);
        const rect = card.getBoundingClientRect();
        const isAfter = event.clientY > rect.top + rect.height / 2;
        const targetIndex = isAfter ? itemIndex + 1 : itemIndex;
        moveCard(
          nextBoard,
          payload.columnIndex,
          payload.itemIndex,
          columnIndex,
          targetIndex,
        );
        updateAndRerender(nextBoard);
      });
      card.addEventListener("dragend", () => {
        card.classList.remove("is-dragging");
      });
      list.appendChild(card);
    });
  });
}

function readCardDragPayload(event: DragEvent): {
  columnIndex: number;
  itemIndex: number;
} | null {
  if (!event.dataTransfer) return null;
  const raw =
    event.dataTransfer.getData("application/x-inline-kanban-card") ||
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

function hasTransferType(event: DragEvent, type: string): boolean {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  return Array.from(types).includes(type);
}

function readColumnDragPayload(
  event: DragEvent,
): { columnIndex: number } | null {
  if (!event.dataTransfer) return null;
  const raw =
    event.dataTransfer.getData("application/x-inline-kanban-column") ||
    event.dataTransfer.getData("text/plain");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { columnIndex: number };
    if (typeof parsed.columnIndex !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

class TextPromptModal extends Modal {
  private readonly title: string;
  private readonly placeholder: string;
  private readonly submitLabel: string;
  private readonly onSubmit: (text: string) => void;

  constructor(
    app: App,
    options: {
      title: string;
      placeholder?: string;
      submitLabel?: string;
      onSubmit: (text: string) => void;
    },
  ) {
    super(app);
    this.title = options.title;
    this.placeholder = options.placeholder ?? "";
    this.submitLabel = options.submitLabel ?? "Add";
    this.onSubmit = options.onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", {
      text: this.title,
    });

    const input = contentEl.createEl("input", {
      type: "text",
      cls: "kanban-add-input",
    });
    if (this.placeholder) {
      input.setAttr("placeholder", this.placeholder);
    }
    input.focus();

    const actions = contentEl.createDiv({ cls: "kanban-add-actions" });
    const addButton = actions.createEl("button", { text: this.submitLabel });
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
