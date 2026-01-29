import {
  App,
  MarkdownPostProcessorContext,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  normalizePath,
} from "obsidian";

type KanbanItem = {
  status: string;
  text: string;
};

type KanbanColumn = {
  name: string;
  rawName: string;
  statusName: string;
  wipLimit?: number;
  items: string[];
};

type KanbanBoard = {
  columns: KanbanColumn[];
};

type InlineKanbanSettings = {
  noteFolder: string;
  noteTemplatePath: string;
};

type ColumnDefinition = {
  rawName: string;
  baseName: string;
  wipLimit?: number;
};

const DEFAULT_COLUMN = "Uncategorized";
const HIGHLIGHT_DURATION_MS = 900;
const DEFAULT_SETTINGS: InlineKanbanSettings = {
  noteFolder: "",
  noteTemplatePath: "",
};
const pendingColumnHighlights = new Map<
  string,
  { name: string; expiresAt: number }
>();
const DEFAULT_KANBAN_TEMPLATE = [
  "```kanban",
  "columns:",
  "  - Todo",
  "  - Doing",
  "  - Done",
  "items:",
  "  - [Todo] Example task",
  "```",
  "",
].join("\n");

export default class InlineKanbanPlugin extends Plugin {
  settings: InlineKanbanSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new InlineKanbanSettingTab(this.app, this));

    this.registerMarkdownCodeBlockProcessor("kanban", (source, el, ctx) => {
      const board = parseKanbanSource(source);
      const updateBoard = createBoardUpdater(this.app, ctx, el);
      const highlightColumnName = getPendingColumnHighlight(ctx.sourcePath);
      renderKanbanBoard(
        board,
        el,
        updateBoard,
        this.app,
        this.settings,
        ctx.sourcePath,
        { highlightColumnName },
      );
    });

    this.addCommand({
      id: "create-kanban-board",
      name: "Create new Kanban board",
      callback: () => {
        void this.createKanbanBoard();
      },
    });

    this.addCommand({
      id: "convert-empty-note-to-kanban",
      name: "Convert empty note to Kanban",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (checking) return true;
        void this.convertEmptyNote(file);
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFolder) {
          menu.addItem((item) => {
            item
              .setTitle("New Kanban board")
              .setIcon("layout-grid")
              .onClick(() => {
                void this.createKanbanBoard(file);
              });
          });
          return;
        }

        if (file instanceof TFile) {
          menu.addItem((item) => {
            item
              .setTitle("Convert empty note to Kanban")
              .setIcon("layout-grid")
              .onClick(() => {
                void this.convertEmptyNote(file);
              });
          });
        }
      }),
    );
  }

  private async createKanbanBoard(folder?: TFolder): Promise<void> {
    const folderPath = folder?.path ?? "";
    const fileName = await getUniqueFileName(
      this.app,
      folderPath,
      "Kanban Board",
    );
    const filePath = folderPath ? `${folderPath}/${fileName}` : fileName;
    const file = await this.app.vault.create(filePath, DEFAULT_KANBAN_TEMPLATE);
    await this.app.workspace.getLeaf(true).openFile(file);
  }

  private async convertEmptyNote(file: TFile): Promise<void> {
    const contents = await this.app.vault.read(file);
    if (contents.trim().length > 0) {
      new Notice("This note is not empty.");
      return;
    }
    await this.app.vault.modify(file, DEFAULT_KANBAN_TEMPLATE);
    new Notice("Converted to Kanban board.");
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

function parseKanbanSource(source: string): KanbanBoard {
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

function parseColumnDefinition(rawName: string): ColumnDefinition {
  const trimmed = rawName.trim();
  const match = /^(.*?)(?:\s*\((\d+)\))\s*$/.exec(trimmed);
  if (!match) {
    return { rawName: trimmed, baseName: trimmed };
  }
  const baseName = match[1].trim();
  const limit = Number(match[2]);
  if (!Number.isFinite(limit)) {
    return { rawName: trimmed, baseName: trimmed };
  }
  return {
    rawName: trimmed,
    baseName: baseName || trimmed,
    wipLimit: limit,
  };
}

function createColumnFromDefinition(
  definition: ColumnDefinition,
): KanbanColumn {
  const name = definition.baseName || definition.rawName;
  return {
    name,
    rawName: definition.rawName,
    statusName: name,
    items: [],
    wipLimit: definition.wipLimit,
  };
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeColumnKey(value: string): string {
  const { baseName } = parseColumnDefinition(value);
  return normalizeKey(baseName || value);
}

async function getUniqueFileName(
  app: App,
  folderPath: string,
  baseName: string,
): Promise<string> {
  const extension = ".md";
  const normalizedFolder = folderPath ? `${folderPath}/` : "";
  let index = 0;

  while (index < 1000) {
    const suffix = index === 0 ? "" : ` ${index}`;
    const candidate = `${baseName}${suffix}${extension}`;
    const path = `${normalizedFolder}${candidate}`;
    const existing = app.vault.getAbstractFileByPath(path);
    if (!existing) return candidate;
    index += 1;
  }

  return `${baseName} ${Date.now()}${extension}`;
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
      rawName: column.rawName,
      statusName: column.statusName,
      wipLimit: column.wipLimit,
      items: [...column.items],
    })),
  };
}

function serializeKanbanBoard(board: KanbanBoard): string {
  const lines: string[] = [];
  lines.push("columns:");
  for (const column of board.columns) {
    lines.push(`  - ${column.rawName}`);
  }
  lines.push("items:");
  for (const column of board.columns) {
    for (const item of column.items) {
      const text = item.trim();
      if (!text) continue;
      lines.push(`  - [${column.statusName}] ${text}`);
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
    queue = queue
      .then(() => updateBlockSource(app, ctx, container, board))
      .catch((error) => {
        console.error("Inline Kanban update failed", error);
      });
  };
}

async function updateBlockSource(
  app: App,
  ctx: MarkdownPostProcessorContext,
  container: HTMLElement,
  board: KanbanBoard,
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

  const blockLines = lines.slice(openIndex + 1, closeIndex);
  const newLines = mergeKanbanBlockLines(blockLines, board);
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

type ItemStyle = "bracket" | "colon";

function mergeKanbanBlockLines(
  blockLines: string[],
  board: KanbanBoard,
): string[] {
  const columnsHeaderIndex = findHeaderIndex(blockLines, /^\s*columns:\s*$/i);
  const itemsHeaderIndex = findHeaderIndex(blockLines, /^\s*items:\s*$/i);

  if (
    columnsHeaderIndex === -1 ||
    itemsHeaderIndex === -1 ||
    columnsHeaderIndex > itemsHeaderIndex
  ) {
    return serializeKanbanBoard(board).split(/\r?\n/);
  }

  const beforeColumns = blockLines.slice(0, columnsHeaderIndex + 1);
  const columnsSectionLines = blockLines.slice(
    columnsHeaderIndex + 1,
    itemsHeaderIndex,
  );
  const itemsHeaderLine = blockLines[itemsHeaderIndex];
  const itemsSectionLines = blockLines.slice(itemsHeaderIndex + 1);

  const columnEntries = board.columns.map((column) => column.rawName);
  const columnsSection = buildSectionLines(
    columnsSectionLines,
    columnEntries,
    blockLines[columnsHeaderIndex],
  );

  const itemStyle = detectItemStyle(itemsSectionLines);
  const itemEntries: string[] = [];
  for (const column of board.columns) {
    for (const item of column.items) {
      const line = formatItemLine(column.statusName, item, itemStyle);
      if (line) itemEntries.push(line);
    }
  }
  const itemsSection = buildSectionLines(
    itemsSectionLines,
    itemEntries,
    itemsHeaderLine,
  );

  return [
    ...beforeColumns,
    ...columnsSection,
    itemsHeaderLine,
    ...itemsSection,
  ];
}

function findHeaderIndex(lines: string[], pattern: RegExp): number {
  return lines.findIndex((line) => pattern.test(line.trim()));
}

function buildSectionLines(
  sectionLines: string[],
  entries: string[],
  headerLine: string,
): string[] {
  const listLineRegex = /^\s*[-*]\s+/;
  let firstListIndex = -1;
  let lastListIndex = -1;

  for (let i = 0; i < sectionLines.length; i += 1) {
    if (listLineRegex.test(sectionLines[i])) {
      firstListIndex = i;
      break;
    }
  }
  for (let i = sectionLines.length - 1; i >= 0; i -= 1) {
    if (listLineRegex.test(sectionLines[i])) {
      lastListIndex = i;
      break;
    }
  }

  const prefix = getListPrefix(sectionLines, headerLine);

  if (firstListIndex === -1) {
    return [...sectionLines, ...entries.map((entry) => `${prefix}${entry}`)];
  }

  const leading = sectionLines.slice(0, firstListIndex);
  const trailing = sectionLines.slice(lastListIndex + 1);
  const newLines = entries.map((entry) => `${prefix}${entry}`);

  return [...leading, ...newLines, ...trailing];
}

function getListPrefix(sectionLines: string[], headerLine: string): string {
  for (const line of sectionLines) {
    const match = /^(\s*[-*]\s+)/.exec(line);
    if (match) return match[1];
  }
  const headerIndent = /^\s*/.exec(headerLine)?.[0] ?? "";
  return `${headerIndent}  - `;
}

function detectItemStyle(sectionLines: string[]): ItemStyle {
  for (const line of sectionLines) {
    const match = /^\s*[-*]\s+(.*)$/.exec(line);
    if (!match) continue;
    const content = match[1].trim();
    if (/^\[[^\]]+\]\s+/.test(content)) return "bracket";
    if (/^[^:]+:\s+/.test(content)) return "colon";
  }
  return "bracket";
}

function formatItemLine(
  status: string,
  text: string,
  style: ItemStyle,
): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return style === "colon" ? `${status}: ${trimmed}` : `[${status}] ${trimmed}`;
}

async function createNoteFromCard(
  app: App,
  settings: InlineKanbanSettings,
  cardText: string,
  sourcePath?: string,
): Promise<void> {
  const trimmed = cardText.trim();
  if (!trimmed) {
    new Notice("Card text is empty.");
    return;
  }

  const folderPath = resolveNoteFolderPath(settings.noteFolder, sourcePath);
  const normalizedFolder = folderPath ? normalizePath(folderPath) : "";

  if (normalizedFolder) {
    const existing = app.vault.getAbstractFileByPath(normalizedFolder);
    if (!existing) {
      await app.vault.createFolder(normalizedFolder);
    } else if (!(existing instanceof TFolder)) {
      new Notice("Note folder path is not a folder.");
      return;
    }
  }

  const baseName = sanitizeFileName(trimmed) || "Kanban Card";
  const fileName = await getUniqueFileName(app, normalizedFolder, baseName);
  const filePath = normalizedFolder
    ? `${normalizedFolder}/${fileName}`
    : fileName;
  const contents = await getNoteTemplateContents(
    app,
    settings.noteTemplatePath,
    trimmed,
  );
  const file = await app.vault.create(filePath, contents);
  await app.workspace.getLeaf(true).openFile(file);
  new Notice(`Created note: ${file.path}`);
}

function resolveNoteFolderPath(
  noteFolder: string,
  sourcePath?: string,
): string {
  const trimmed = noteFolder.trim();
  if (trimmed) return trimmed;
  if (!sourcePath) return "";
  const lastSlash = sourcePath.lastIndexOf("/");
  return lastSlash === -1 ? "" : sourcePath.slice(0, lastSlash);
}

async function getNoteTemplateContents(
  app: App,
  templatePath: string,
  title: string,
): Promise<string> {
  const trimmed = templatePath.trim();
  if (!trimmed) return `# ${title}\n`;
  const normalizedTemplate = normalizePath(trimmed);
  const templateFile = app.vault.getAbstractFileByPath(normalizedTemplate);
  if (!(templateFile instanceof TFile)) {
    new Notice("Template file not found. Using default note content.");
    return `# ${title}\n`;
  }
  const template = await app.vault.read(templateFile);
  return template.replace(/\{\{\s*title\s*\}\}/gi, title);
}

function sanitizeFileName(raw: string): string {
  return raw
    .replace(/[\\/#%*?:"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  settings: InlineKanbanSettings,
  sourcePath?: string,
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
    renderKanbanBoard(
      nextBoard,
      container,
      updateBoard,
      app,
      settings,
      sourcePath,
      nextOptions,
    );
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
        const definition = parseColumnDefinition(name);
        const exists = nextBoard.columns.some(
          (column) =>
            normalizeColumnKey(column.rawName) ===
            normalizeColumnKey(definition.rawName),
        );
        if (exists) return;
        nextBoard.columns.push(createColumnFromDefinition(definition));
        updateAndRerender(nextBoard);
      },
    });
    modal.open();
  });
  toolbar.appendChild(addColumnButton);

  const highlightKey = options.highlightColumnName
    ? normalizeColumnKey(options.highlightColumnName)
    : null;

  board.columns.forEach((column, columnIndex) => {
    const columnEl = document.createElement("div");
    columnEl.className = "kanban-column";
    if (highlightKey && normalizeColumnKey(column.name) === highlightKey) {
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

    const promptRenameColumn = (): void => {
      const modal = new TextPromptModal(app, {
        title: `Rename column "${column.name}"`,
        placeholder: "Column name",
        submitLabel: "Rename",
        initialValue: column.rawName,
        onSubmit: (value) => {
          const name = value.trim();
          if (!name) return;
          const definition = parseColumnDefinition(name);
          const normalizedName = normalizeColumnKey(definition.rawName);
          const nextBoard = cloneBoard(board);
          const conflict = nextBoard.columns.some((entry, index) => {
            if (index === columnIndex) return false;
            return normalizeColumnKey(entry.rawName) === normalizedName;
          });
          if (conflict) {
            new Notice("A column with that name already exists.");
            return;
          }
          const updated = createColumnFromDefinition(definition);
          updated.items = [...(nextBoard.columns[columnIndex]?.items ?? [])];
          nextBoard.columns[columnIndex] = updated;
          updateAndRerender(nextBoard, updated.name);
        },
      });
      modal.open();
    };

    title.addEventListener("dblclick", (event) => {
      event.preventDefault();
      promptRenameColumn();
    });
    header.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const menu = new Menu();
      menu.addItem((menuItem) => {
        menuItem
          .setTitle("Rename column")
          .setIcon("pencil")
          .onClick(() => {
            promptRenameColumn();
          });
      });
      menu.showAtMouseEvent(event);
    });

    const wipLimit = column.wipLimit;
    if (typeof wipLimit === "number") {
      const wipBadge = document.createElement("span");
      wipBadge.className = "kanban-wip-badge";
      const itemCount = column.items.length;
      wipBadge.textContent = `${itemCount}/${wipLimit}`;
      if (itemCount > wipLimit) {
        columnEl.classList.add("is-wip-limit-exceeded");
        wipBadge.classList.add("is-over-limit");
      }
      header.appendChild(wipBadge);
    }

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
      const promptRenameCard = (): void => {
        const modal = new TextPromptModal(app, {
          title: "Rename card",
          placeholder: "Card title",
          submitLabel: "Rename",
          initialValue: item,
          onSubmit: (value) => {
            const name = value.trim();
            if (!name) return;
            const nextBoard = cloneBoard(board);
            const target = nextBoard.columns[columnIndex]?.items;
            if (!target || !target[itemIndex]) return;
            target[itemIndex] = name;
            updateAndRerender(nextBoard);
          },
        });
        modal.open();
      };
      card.addEventListener("dblclick", (event) => {
        event.preventDefault();
        promptRenameCard();
      });
      card.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const menu = new Menu();
        menu.addItem((menuItem) => {
          menuItem
            .setTitle("Rename card")
            .setIcon("pencil")
            .onClick(() => {
              promptRenameCard();
            });
        });
        menu.addItem((menuItem) => {
          menuItem
            .setTitle("Create note from card")
            .setIcon("file-plus")
            .onClick(() => {
              void createNoteFromCard(app, settings, item, sourcePath);
            });
        });
        menu.showAtMouseEvent(event);
      });
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
  private readonly initialValue: string;

  constructor(
    app: App,
    options: {
      title: string;
      placeholder?: string;
      submitLabel?: string;
      initialValue?: string;
      onSubmit: (text: string) => void;
    },
  ) {
    super(app);
    this.title = options.title;
    this.placeholder = options.placeholder ?? "";
    this.submitLabel = options.submitLabel ?? "Add";
    this.initialValue = options.initialValue ?? "";
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
    if (this.initialValue) {
      input.value = this.initialValue;
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

class InlineKanbanSettingTab extends PluginSettingTab {
  private readonly plugin: InlineKanbanPlugin;

  constructor(app: App, plugin: InlineKanbanPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Inline Kanban settings" });

    new Setting(containerEl)
      .setName("New note folder")
      .setDesc(
        "Folder for notes created from cards. Leave blank to use the board folder.",
      )
      .addText((text) =>
        text
          .setPlaceholder("Notes")
          .setValue(this.plugin.settings.noteFolder)
          .onChange(async (value) => {
            this.plugin.settings.noteFolder = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("New note template")
      .setDesc('Optional template file path. Use "{{title}}" as a placeholder.')
      .addText((text) =>
        text
          .setPlaceholder("Templates/Kanban Note.md")
          .setValue(this.plugin.settings.noteTemplatePath)
          .onChange(async (value) => {
            this.plugin.settings.noteTemplatePath = value.trim();
            await this.plugin.saveSettings();
          }),
      );
  }
}
