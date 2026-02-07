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
import {
  createColumnFromDefinition,
  DEFAULT_COLUMN,
  normalizeColumnKey,
  parseColumnDefinition,
  parseKanbanSource,
  type KanbanBoard,
} from "./kanban-core";
import { parseCardDragPayload, parseColumnDragPayload } from "./drag-payload";

type InlineKanbanSettings = {
  noteFolder: string;
  noteFolderPattern: string;
  noteTemplatePath: string;
};
const HIGHLIGHT_DURATION_MS = 900;
const MAX_FILE_NAME_ATTEMPTS = 1000;
const MAX_CARD_NOTE_FILENAME_LENGTH = 40;
const AUTO_SCROLL_MAX_SPEED = 12; // pixels per frame at max intensity
const AUTO_SCROLL_EDGE_SIZE = 80; // smaller edge zone for quicker activation
const AUTO_SCROLL_MIN_SPEED = 1.5; // minimum speed to start scrolling immediately
const DEFAULT_SETTINGS: InlineKanbanSettings = {
  noteFolder: "",
  noteFolderPattern: "._{board}",
  noteTemplatePath: "",
};
const pendingColumnHighlights = new Map<
  string,
  { name: string; expiresAt: number }
>();
const boardScrollPositions = new Map<string, number>();
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
      const boardKey = getBoardKey(ctx, el);
      renderKanbanBoard(
        board,
        el,
        updateBoard,
        this.app,
        this.settings,
        ctx.sourcePath,
        { highlightColumnName, boardKey },
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

    this.addCommand({
      id: "add-kanban-board-to-current-note",
      name: "Add Kanban board to current note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (checking) return true;
        void this.addKanbanBoardToCurrentNote(file);
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

  private async addKanbanBoardToCurrentNote(file: TFile): Promise<void> {
    const contents = await this.app.vault.read(file);
    const nextContents = appendKanbanBoardToContents(contents);
    await this.app.vault.modify(file, nextContents);
    new Notice("Added Kanban board to current note.");
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function isValidColumnIndex(board: KanbanBoard, columnIndex: number): boolean {
  return (
    isNonNegativeInteger(columnIndex) && columnIndex < board.columns.length
  );
}

function isValidItemIndex(
  board: KanbanBoard,
  columnIndex: number,
  itemIndex: number,
): boolean {
  if (!isValidColumnIndex(board, columnIndex)) return false;
  return (
    isNonNegativeInteger(itemIndex) &&
    itemIndex < board.columns[columnIndex].items.length
  );
}

function isEventTargetNode(target: EventTarget | null): target is Node {
  return !!target && target instanceof Node;
}

async function getUniqueFileName(
  app: App,
  folderPath: string,
  baseName: string,
): Promise<string> {
  const extension = ".md";
  const normalizedFolder = folderPath ? `${folderPath}/` : "";
  let index = 0;

  while (index < MAX_FILE_NAME_ATTEMPTS) {
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

function appendKanbanBoardToContents(contents: string): string {
  if (!contents.trim()) return DEFAULT_KANBAN_TEMPLATE;
  if (/\n\s*\n\s*$/.test(contents)) {
    return `${contents}${DEFAULT_KANBAN_TEMPLATE}`;
  }
  if (/\n\s*$/.test(contents)) {
    return `${contents}\n${DEFAULT_KANBAN_TEMPLATE}`;
  }
  return `${contents}\n\n${DEFAULT_KANBAN_TEMPLATE}`;
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

function getBoardKey(
  ctx: MarkdownPostProcessorContext,
  container: HTMLElement,
): string | undefined {
  const section = ctx.getSectionInfo(container);
  if (section?.lineStart == null) return ctx.sourcePath || undefined;
  return `${ctx.sourcePath}:${section.lineStart}`;
}

function normalizeHexColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!/^#[0-9a-f]{3}([0-9a-f]{3})?([0-9a-f]{2})?$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function buildColumnRawName(
  baseName: string,
  wipLimit?: number,
  color?: string,
): string {
  const safeName = baseName.trim() || DEFAULT_COLUMN;
  let rawName = safeName;
  if (typeof wipLimit === "number") {
    rawName = `${rawName} (${wipLimit})`;
  }
  if (color) {
    rawName = `${rawName} {${color}}`;
  }
  return rawName;
}

function cloneBoard(board: KanbanBoard): KanbanBoard {
  return {
    columns: board.columns.map((column) => ({
      name: column.name,
      rawName: column.rawName,
      statusName: column.statusName,
      wipLimit: column.wipLimit,
      color: column.color,
      items: [...column.items],
    })),
  };
}

function serializeKanbanBoard(board: KanbanBoard): string {
  const lines: string[] = [];
  const listPrefix = "  - ";
  lines.push("columns:");
  for (const column of board.columns) {
    lines.push(`${listPrefix}${column.rawName}`);
  }
  lines.push("items:");
  for (const column of board.columns) {
    for (const item of column.items) {
      const entryLines = formatItemLines(column.statusName, item, "bracket");
      if (!entryLines.length) continue;
      lines.push(...formatListEntryLines(entryLines, listPrefix));
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
        new Notice("Inline Kanban update failed. Check console for details.");
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
  const itemEntries: Array<string | string[]> = [];
  for (const column of board.columns) {
    for (const item of column.items) {
      const lines = formatItemLines(column.statusName, item, itemStyle);
      if (lines.length) itemEntries.push(lines);
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
  entries: Array<string | string[]>,
  headerLine: string,
): string[] {
  const listLineRegex = /^\s*[-*]\s+/;
  let firstListIndex = -1;
  let lastListIndex = -1;
  let lastListLineIndex = -1;

  for (let i = 0; i < sectionLines.length; i += 1) {
    if (listLineRegex.test(sectionLines[i])) {
      if (firstListIndex === -1) {
        firstListIndex = i;
      }
      lastListIndex = i;
      lastListLineIndex = i;
    }
  }
  if (lastListLineIndex !== -1) {
    for (let i = lastListLineIndex + 1; i < sectionLines.length; i += 1) {
      const line = sectionLines[i];
      if (!line.trim() || /^\s+/.test(line)) {
        lastListIndex = i;
        continue;
      }
      break;
    }
  }

  const prefix = getListPrefix(sectionLines, headerLine);
  const newLines = entries.flatMap((entry) =>
    formatListEntryLines(entry, prefix),
  );

  if (firstListIndex === -1) {
    return [...sectionLines, ...newLines];
  }

  const leading = sectionLines.slice(0, firstListIndex);
  const trailing = sectionLines.slice(lastListIndex + 1);

  return [...leading, ...newLines, ...trailing];
}

function formatListEntryLines(
  entry: string | string[],
  prefix: string,
): string[] {
  const rawLines = Array.isArray(entry) ? entry : entry.split(/\r?\n/);
  const lines = rawLines.map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const continuationIndent = " ".repeat(prefix.length);
  return lines.map((line, index) =>
    index === 0 ? `${prefix}${line}` : `${continuationIndent}${line}`,
  );
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

function formatItemLines(
  status: string,
  text: string,
  style: ItemStyle,
): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const first =
    style === "colon" ? `${status}: ${lines[0]}` : `[${status}] ${lines[0]}`;
  return [first, ...lines.slice(1)];
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

  const wikiTarget = extractWikiLinkTarget(trimmed);
  if (wikiTarget) {
    app.workspace.openLinkText(wikiTarget, sourcePath ?? "", false);
    return;
  }

  const markdownTarget = extractMarkdownLinkTarget(trimmed);
  if (markdownTarget) {
    if (/^https?:\/\//i.test(markdownTarget)) {
      window.open(markdownTarget, "_blank");
    } else {
      app.workspace.openLinkText(markdownTarget, sourcePath ?? "", false);
    }
    return;
  }

  try {
    const folderPath = resolveNoteFolderPath(
      settings.noteFolder,
      settings.noteFolderPattern,
      sourcePath,
    );
    const normalizedFolder = folderPath ? normalizePath(folderPath) : "";
    if (!(await ensureNoteFolder(app, normalizedFolder))) return;

    const baseName =
      sanitizeFileName(trimmed, MAX_CARD_NOTE_FILENAME_LENGTH) || "Kanban Card";
    const filePath = normalizedFolder
      ? `${normalizedFolder}/${baseName}.md`
      : `${baseName}.md`;
    const existingFile = app.vault.getAbstractFileByPath(filePath);
    if (existingFile instanceof TFile) {
      await app.workspace.getLeaf(true).openFile(existingFile);
      new Notice(`Opened note: ${existingFile.path}`);
      return;
    }
    if (existingFile) {
      new Notice("Note path is not a file.");
      return;
    }
    const contents = await getNoteTemplateContents(
      app,
      settings.noteTemplatePath,
      trimmed,
    );
    const file = await app.vault.create(filePath, contents);
    if (!file) {
      console.error("Vault returned null for created note", { filePath });
      new Notice("Failed to create note from card. Check console for details.");
      return;
    }
    await app.workspace.getLeaf(true).openFile(file);
    new Notice(`Created note: ${file.path}`);
  } catch (error) {
    console.error("Failed to create note from card", error);
    new Notice("Failed to create note from card. Check console for details.");
  }
}

async function ensureNoteFolder(
  app: App,
  folderPath: string,
): Promise<boolean> {
  if (!folderPath) return true;
  const existing = app.vault.getAbstractFileByPath(folderPath);
  if (!existing) {
    try {
      await app.vault.createFolder(folderPath);
      return true;
    } catch (error) {
      console.error("Failed to create note folder", error);
      new Notice("Failed to create note folder. Check console for details.");
      return false;
    }
  }
  if (!(existing instanceof TFolder)) {
    new Notice("Note folder path is not a folder.");
    return false;
  }
  return true;
}

function resolveNoteFolderPath(
  noteFolder: string,
  noteFolderPattern: string,
  sourcePath?: string,
): string {
  const trimmed = noteFolder.trim();
  if (!sourcePath) return trimmed;
  const lastSlash = sourcePath.lastIndexOf("/");
  const fileName =
    lastSlash === -1 ? sourcePath : sourcePath.slice(lastSlash + 1);
  const lastDot = fileName.lastIndexOf(".");
  const rawBaseName = lastDot > 0 ? fileName.slice(0, lastDot) : fileName;
  const baseName = sanitizeFileName(rawBaseName) || "Kanban Board";
  const subfolderName = formatNoteSubfolderName(noteFolderPattern, baseName);
  if (trimmed) return `${trimmed}/${subfolderName}`;
  const parentFolder = lastSlash === -1 ? "" : sourcePath.slice(0, lastSlash);
  return parentFolder ? `${parentFolder}/${subfolderName}` : subfolderName;
}

function formatNoteSubfolderName(pattern: string, boardName: string): string {
  const trimmed = pattern.trim();
  const safeBoardName = sanitizeFileName(boardName) || "Kanban Board";
  if (!trimmed) return safeBoardName;
  if (/\{board\}/i.test(trimmed)) {
    return trimmed.replace(/\{board\}/gi, safeBoardName);
  }
  return `${trimmed}${safeBoardName}`;
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
  try {
    const template = await app.vault.read(templateFile);
    return template.replace(/\{\{\s*title\s*\}\}/gi, title);
  } catch (error) {
    console.error("Failed to read note template", error);
    new Notice("Template read failed. Using default note content.");
    return `# ${title}\n`;
  }
}

function sanitizeFileName(raw: string, maxLength?: number): string {
  const sanitized = raw
    .replace(/[\\/#%*?:"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!maxLength || sanitized.length <= maxLength) return sanitized;
  return sanitized.slice(0, maxLength).trim();
}

function extractWikiLinkTarget(text: string): string | null {
  const match = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/.exec(text);
  return match?.[1].trim() || null;
}

function extractMarkdownLinkTarget(text: string): string | null {
  const match = /\[[^\]]*]\(([^)]+)\)/.exec(text);
  return match?.[1].trim() || null;
}

function extractCardDateTime(text: string): { date?: string; time?: string } {
  const dateMatch = /@(\d{4}-\d{2}-\d{2})/.exec(text);
  const timeMatch = /@@(\d{1,2}:\d{2})/.exec(text);
  return {
    date: dateMatch?.[1],
    time: timeMatch?.[1],
  };
}

function applyCardDateTime(
  text: string,
  date: string,
  time: string | undefined,
  setTime: boolean,
): string {
  let next = text.trim();
  const dateToken = `@${date}`;
  if (/@\d{4}-\d{2}-\d{2}/.test(next)) {
    next = next.replace(/@\d{4}-\d{2}-\d{2}/, dateToken);
  } else {
    next = `${next} ${dateToken}`.trim();
  }

  if (setTime && time) {
    const timeToken = `@@${time}`;
    if (/@@\d{1,2}:\d{2}/.test(next)) {
      next = next.replace(/@@\d{1,2}:\d{2}/, timeToken);
    } else {
      next = `${next} ${timeToken}`.trim();
    }
  }

  return next;
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

type ColumnDropInfo = {
  insertIndex: number;
  indicatorLeft: number;
};

type ColumnDropContext = {
  board: KanbanBoard;
  boardEl: HTMLElement;
  dropIndicator: HTMLElement;
  updateAndRerender: (board: KanbanBoard, highlightColumnName?: string) => void;
};

function createBoardShell(container: HTMLElement): {
  toolbar: HTMLDivElement;
  boardEl: HTMLDivElement;
  dropIndicator: HTMLDivElement;
} {
  const toolbar = document.createElement("div");
  toolbar.className = "kanban-toolbar";
  container.appendChild(toolbar);

  const boardEl = document.createElement("div");
  boardEl.className = "kanban-board";
  container.appendChild(boardEl);

  const dropIndicator = document.createElement("div");
  dropIndicator.className = "kanban-drop-indicator";
  boardEl.appendChild(dropIndicator);

  return { toolbar, boardEl, dropIndicator };
}

function renderEmptyBoard(boardEl: HTMLElement): void {
  const empty = document.createElement("div");
  empty.className = "kanban-empty";
  empty.textContent = "No kanban items found.";
  boardEl.appendChild(empty);
}

function getColumnDropInfo(
  boardEl: HTMLElement,
  clientX: number,
): ColumnDropInfo | null {
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
}

function showColumnIndicatorAt(
  { boardEl, dropIndicator }: ColumnDropContext,
  clientX: number,
): void {
  const info = getColumnDropInfo(boardEl, clientX);
  if (!info) return;
  dropIndicator.style.left = `${Math.max(0, info.indicatorLeft - 2)}px`;
  dropIndicator.style.opacity = "1";
}

function clearColumnIndicators(dropIndicator: HTMLElement): void {
  dropIndicator.style.opacity = "0";
}

function getColumnIndexAtX(
  boardEl: HTMLElement,
  clientX: number,
): number | null {
  const columns = Array.from(
    boardEl.querySelectorAll<HTMLElement>(".kanban-column"),
  );
  if (columns.length === 0) return null;
  for (let i = 0; i < columns.length; i += 1) {
    const rect = columns[i].getBoundingClientRect();
    if (clientX >= rect.left && clientX <= rect.right) return i;
  }
  const firstRect = columns[0].getBoundingClientRect();
  if (clientX < firstRect.left) return 0;
  const lastIndex = columns.length - 1;
  const lastRect = columns[lastIndex].getBoundingClientRect();
  if (clientX > lastRect.right) return lastIndex;
  return null;
}

function handleColumnDropEvent(
  event: DragEvent,
  context: ColumnDropContext,
  options: { stopPropagation?: boolean } = {},
): boolean {
  const columnPayload = readColumnDragPayload(event);
  if (!columnPayload) return false;
  if (options.stopPropagation) event.stopPropagation();
  if (!isValidColumnIndex(context.board, columnPayload.columnIndex)) {
    return true;
  }
  const info = getColumnDropInfo(context.boardEl, event.clientX);
  if (!info) return true;
  const nextBoard = cloneBoard(context.board);
  const movedName = nextBoard.columns[columnPayload.columnIndex]?.name;
  moveColumn(nextBoard, columnPayload.columnIndex, info.insertIndex);
  context.updateAndRerender(nextBoard, movedName);
  return true;
}

type RenderOptions = {
  highlightColumnName?: string;
  boardKey?: string;
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
  const boardKey = options.boardKey;
  const existingBoardEl = container.querySelector<HTMLElement>(".kanban-board");
  const preservedScrollLeft =
    existingBoardEl?.scrollLeft ??
    (boardKey ? (boardScrollPositions.get(boardKey) ?? 0) : 0);
  container.innerHTML = "";
  container.classList.add("inline-kanban");
  const { toolbar, boardEl, dropIndicator } = createBoardShell(container);
  const restoreScrollLeft = (): void => {
    if (!Number.isFinite(preservedScrollLeft)) return;
    requestAnimationFrame(() => {
      boardEl.scrollLeft = preservedScrollLeft;
    });
  };
  restoreScrollLeft();
  if (boardKey) {
    boardEl.addEventListener("scroll", () => {
      boardScrollPositions.set(boardKey, boardEl.scrollLeft);
    });
  }

  if (board.columns.length === 0) {
    renderEmptyBoard(boardEl);
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
      { ...nextOptions, boardKey },
    );
  };

  const updateAndRerender = (
    nextBoard: KanbanBoard,
    highlightColumnName?: string,
  ): void => {
    if (boardKey) {
      boardScrollPositions.set(boardKey, boardEl.scrollLeft);
    }
    updateBoard(nextBoard, highlightColumnName);
    rerender(nextBoard, highlightColumnName ? { highlightColumnName } : {});
  };

  const dropContext: ColumnDropContext = {
    board,
    boardEl,
    dropIndicator,
    updateAndRerender,
  };

  let autoScrollTargetX = 0;
  let autoScrollVelocityX = 0;
  let autoScrollRemainderX = 0;
  let autoScrollTargetY = 0;
  let autoScrollVelocityY = 0;
  let autoScrollRemainderY = 0;
  let autoScrollFrame: number | null = null;
  const scrollContainer = findScrollableAncestor(boardEl);

  const startAutoScrollLoop = (): void => {
    if (autoScrollFrame != null) return;
    const tick = (): void => {
      // Faster lerp (0.2) for responsive feel while still being smooth
      autoScrollVelocityX +=
        (autoScrollTargetX - autoScrollVelocityX) * 0.2;
      autoScrollVelocityY +=
        (autoScrollTargetY - autoScrollVelocityY) * 0.2;
      const stepX = autoScrollVelocityX;
      const stepY = autoScrollVelocityY;
      if (
        Math.abs(stepX) < 0.1 &&
        Math.abs(autoScrollTargetX) < 0.1 &&
        Math.abs(stepY) < 0.1 &&
        Math.abs(autoScrollTargetY) < 0.1
      ) {
        autoScrollVelocityX = 0;
        autoScrollVelocityY = 0;
        autoScrollRemainderX = 0;
        autoScrollRemainderY = 0;
        autoScrollFrame = null;
        return;
      }
      autoScrollRemainderX += stepX;
      autoScrollRemainderY += stepY;
      const intStepX = Math.trunc(autoScrollRemainderX);
      const intStepY = Math.trunc(autoScrollRemainderY);
      if (intStepX !== 0) {
        autoScrollRemainderX -= intStepX;
        const maxScrollLeft = Math.max(
          0,
          boardEl.scrollWidth - boardEl.clientWidth,
        );
        const nextScroll = Math.max(
          0,
          Math.min(boardEl.scrollLeft + intStepX, maxScrollLeft),
        );
        boardEl.scrollLeft = nextScroll;
      }
      if (scrollContainer && intStepY !== 0) {
        autoScrollRemainderY -= intStepY;
        const maxScrollTop = Math.max(
          0,
          scrollContainer.scrollHeight - scrollContainer.clientHeight,
        );
        const nextScroll = Math.max(
          0,
          Math.min(scrollContainer.scrollTop + intStepY, maxScrollTop),
        );
        scrollContainer.scrollTop = nextScroll;
      }
      autoScrollFrame = requestAnimationFrame(tick);
    };
    autoScrollFrame = requestAnimationFrame(tick);
  };

  const updateAutoScroll = (clientX?: number, clientY?: number): void => {
    const rect = boardEl.getBoundingClientRect();
    const edgeSize = Math.max(
      24,
      Math.min(AUTO_SCROLL_EDGE_SIZE, rect.width * 0.45),
    );
    const maxSpeed = AUTO_SCROLL_MAX_SPEED;
    const maxScrollLeft = Math.max(
      0,
      boardEl.scrollWidth - boardEl.clientWidth,
    );

    if (clientX == null || rect.width <= edgeSize * 2 || maxScrollLeft <= 0) {
      autoScrollTargetX = 0;
      startAutoScrollLoop();
    } else {
      let direction = 0;
      let strength = 0;
      if (clientX < rect.left + edgeSize) {
        direction = -1;
        strength = (rect.left + edgeSize - clientX) / edgeSize;
      } else if (clientX > rect.right - edgeSize) {
        direction = 1;
        strength = (clientX - (rect.right - edgeSize)) / edgeSize;
      }

      if (direction === 0) {
        autoScrollTargetX = 0;
      } else if (
        (direction < 0 && boardEl.scrollLeft <= 0) ||
        (direction > 0 && boardEl.scrollLeft >= maxScrollLeft)
      ) {
        autoScrollTargetX = 0;
      } else {
        const eased = Math.min(1, strength) ** 2;
        // Use min speed for immediate response, then scale up to max
        const speed =
          AUTO_SCROLL_MIN_SPEED + (maxSpeed - AUTO_SCROLL_MIN_SPEED) * eased;
        autoScrollTargetX = direction * speed;
      }
      startAutoScrollLoop();
    }

    if (!scrollContainer) {
      autoScrollTargetY = 0;
      startAutoScrollLoop();
      return;
    }

    const scrollRect = scrollContainer.getBoundingClientRect();
    const verticalEdgeSize = Math.max(
      24,
      Math.min(AUTO_SCROLL_EDGE_SIZE, scrollRect.height * 0.45),
    );
    const maxScrollTop = Math.max(
      0,
      scrollContainer.scrollHeight - scrollContainer.clientHeight,
    );

    if (
      clientY == null ||
      scrollRect.height <= verticalEdgeSize * 2 ||
      maxScrollTop <= 0
    ) {
      autoScrollTargetY = 0;
      startAutoScrollLoop();
      return;
    }

    let yDirection = 0;
    let yStrength = 0;
    if (clientY < scrollRect.top + verticalEdgeSize) {
      yDirection = -1;
      yStrength = (scrollRect.top + verticalEdgeSize - clientY) / verticalEdgeSize;
    } else if (clientY > scrollRect.bottom - verticalEdgeSize) {
      yDirection = 1;
      yStrength =
        (clientY - (scrollRect.bottom - verticalEdgeSize)) / verticalEdgeSize;
    }

    if (yDirection === 0) {
      autoScrollTargetY = 0;
    } else if (
      (yDirection < 0 && scrollContainer.scrollTop <= 0) ||
      (yDirection > 0 && scrollContainer.scrollTop >= maxScrollTop)
    ) {
      autoScrollTargetY = 0;
    } else {
      const eased = Math.min(1, yStrength) ** 2;
      const speed =
        AUTO_SCROLL_MIN_SPEED + (maxSpeed - AUTO_SCROLL_MIN_SPEED) * eased;
      autoScrollTargetY = yDirection * speed;
    }
    startAutoScrollLoop();
  };

  boardEl.addEventListener("dragover", (event) => {
    const isColumnDrag = hasTransferType(
      event,
      "application/x-inline-kanban-column",
    );
    const isCardDrag = hasTransferType(
      event,
      "application/x-inline-kanban-card",
    );
    if (!isColumnDrag && !isCardDrag) return;
    event.preventDefault();
    if (isColumnDrag) {
      showColumnIndicatorAt(dropContext, event.clientX);
    }
    updateAutoScroll(event.clientX, event.clientY);
  });

  boardEl.addEventListener("dragleave", (event) => {
    const relatedTarget = event.relatedTarget;
    if (!isEventTargetNode(relatedTarget) || !boardEl.contains(relatedTarget)) {
      clearColumnIndicators(dropIndicator);
      updateAutoScroll();
    }
  });

  boardEl.addEventListener("drop", (event) => {
    const handled = handleColumnDropEvent(event, dropContext);
    if (handled) {
      event.preventDefault();
      clearColumnIndicators(dropIndicator);
      updateAutoScroll();
      return;
    }

    const payload = readCardDragPayload(event);
    if (!payload) return;
    if (!isValidItemIndex(board, payload.columnIndex, payload.itemIndex)) {
      return;
    }
    const targetColumnIndex = getColumnIndexAtX(boardEl, event.clientX);
    if (targetColumnIndex == null) return;
    event.preventDefault();
    clearColumnIndicators(dropIndicator);
    updateAutoScroll();

    const nextBoard = cloneBoard(board);
    moveCard(
      nextBoard,
      payload.columnIndex,
      payload.itemIndex,
      targetColumnIndex,
      nextBoard.columns[targetColumnIndex]?.items.length ?? 0,
    );
    updateAndRerender(nextBoard);
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
    if (column.color) {
      columnEl.classList.add("has-color");
      columnEl.style.setProperty("--kanban-column-color", column.color);
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

    const applyColumnColor = (nextColor?: string): void => {
      const nextBoard = cloneBoard(board);
      const target = nextBoard.columns[columnIndex];
      if (!target) return;
      target.color = nextColor;
      target.rawName = buildColumnRawName(
        target.name,
        target.wipLimit,
        nextColor,
      );
      updateAndRerender(nextBoard, target.name);
    };

    const promptSetColumnColor = (): void => {
      const modal = new ColorPromptModal(app, {
        title: `Set color for "${column.name}"`,
        submitLabel: "Set color",
        initialValue: column.color,
        onSubmit: (value) => {
          const nextColor = normalizeHexColor(value);
          if (!nextColor) return;
          applyColumnColor(nextColor);
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
      menu.addItem((menuItem) => {
        menuItem
          .setTitle("Set column color")
          .setIcon("palette")
          .onClick(() => {
            promptSetColumnColor();
          });
      });
      if (column.color) {
        menu.addItem((menuItem) => {
          menuItem
            .setTitle("Clear column color")
            .setIcon("x")
            .onClick(() => {
              applyColumnColor(undefined);
            });
        });
      }
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
        multiline: true,
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
      clearColumnIndicators(dropIndicator);
    });

    const handleColumnDrop = (event: DragEvent): void => {
      event.preventDefault();
      setDragOver(false);
      clearColumnIndicators(dropIndicator);
      const handled = handleColumnDropEvent(event, dropContext, {
        stopPropagation: true,
      });
      if (handled) return;

      const payload = readCardDragPayload(event);
      if (!payload) return;
      if (!isValidItemIndex(board, payload.columnIndex, payload.itemIndex)) {
        return;
      }
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
      updateAutoScroll(event.clientX, event.clientY);
      if (hasTransferType(event, "application/x-inline-kanban-column")) {
        showColumnIndicatorAt(dropContext, event.clientX);
        setDragOver(false);
        return;
      }

      clearColumnIndicators(dropIndicator);
      setDragOver(true);
    });
    columnEl.addEventListener("dragleave", (event) => {
      const relatedTarget = event.relatedTarget;
      if (
        !isEventTargetNode(relatedTarget) ||
        !columnEl.contains(relatedTarget)
      ) {
        setDragOver(false);
        clearColumnIndicators(dropIndicator);
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
          multiline: true,
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
      const promptSetCardDate = (): void => {
        const { date, time } = extractCardDateTime(item);
        const modal = new DateTimePromptModal(app, {
          title: "Set card date",
          submitLabel: "Set date",
          includeTime: false,
          initialDate: date,
          initialTime: time,
          onSubmit: ({ nextDate }) => {
            const nextBoard = cloneBoard(board);
            const target = nextBoard.columns[columnIndex]?.items;
            if (!target || !target[itemIndex]) return;
            target[itemIndex] = applyCardDateTime(
              target[itemIndex],
              nextDate,
              undefined,
              false,
            );
            updateAndRerender(nextBoard);
          },
        });
        modal.open();
      };
      const promptSetCardDateTime = (): void => {
        const { date, time } = extractCardDateTime(item);
        const modal = new DateTimePromptModal(app, {
          title: "Set card date & time",
          submitLabel: "Set date & time",
          includeTime: true,
          initialDate: date,
          initialTime: time,
          onSubmit: ({ nextDate, nextTime }) => {
            const nextBoard = cloneBoard(board);
            const target = nextBoard.columns[columnIndex]?.items;
            if (!target || !target[itemIndex]) return;
            target[itemIndex] = applyCardDateTime(
              target[itemIndex],
              nextDate,
              nextTime,
              true,
            );
            updateAndRerender(nextBoard);
          },
        });
        modal.open();
      };
      const promptRemoveCard = (): void => {
        const confirmed = window.confirm(`Remove card "${item}"?`);
        if (!confirmed) return;
        const nextBoard = cloneBoard(board);
        const target = nextBoard.columns[columnIndex]?.items;
        if (!target || !target[itemIndex]) return;
        target.splice(itemIndex, 1);
        updateAndRerender(nextBoard);
      };
      card.addEventListener("click", (event) => {
        if (!event.metaKey && !event.ctrlKey) return;
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        void createNoteFromCard(app, settings, item, sourcePath);
      });
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
            .setTitle("Remove card")
            .setIcon("trash")
            .onClick(() => {
              promptRemoveCard();
            });
        });
        menu.addItem((menuItem) => {
          menuItem
            .setTitle("Set date")
            .setIcon("calendar")
            .onClick(() => {
              promptSetCardDate();
            });
        });
        menu.addItem((menuItem) => {
          menuItem
            .setTitle("Set date & time")
            .setIcon("clock")
            .onClick(() => {
              promptSetCardDateTime();
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
        updateAutoScroll(event.clientX, event.clientY);
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
        clearColumnIndicators(dropIndicator);
        const handled = handleColumnDropEvent(event, dropContext);
        if (handled) return;

        const payload = readCardDragPayload(event);
        if (!payload) return;
        if (!isValidItemIndex(board, payload.columnIndex, payload.itemIndex)) {
          return;
        }
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
        updateAutoScroll();
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
  return parseCardDragPayload(raw);
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
  return parseColumnDragPayload(raw);
}

function findScrollableAncestor(start: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = start;
  while (current) {
    const style = getComputedStyle(current);
    const overflowY = style.overflowY;
    const canScroll =
      (overflowY === "auto" || overflowY === "scroll") &&
      current.scrollHeight > current.clientHeight + 1;
    if (canScroll) return current;
    current = current.parentElement;
  }
  const scrollingElement = document.scrollingElement;
  return scrollingElement instanceof HTMLElement ? scrollingElement : null;
}

class TextPromptModal extends Modal {
  private readonly title: string;
  private readonly placeholder: string;
  private readonly submitLabel: string;
  private readonly onSubmit: (text: string) => void;
  private readonly initialValue: string;
  private readonly multiline: boolean;

  constructor(
    app: App,
    options: {
      title: string;
      placeholder?: string;
      submitLabel?: string;
      initialValue?: string;
      multiline?: boolean;
      onSubmit: (text: string) => void;
    },
  ) {
    super(app);
    this.title = options.title;
    this.placeholder = options.placeholder ?? "";
    this.submitLabel = options.submitLabel ?? "Add";
    this.initialValue = options.initialValue ?? "";
    this.multiline = options.multiline ?? false;
    this.onSubmit = options.onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", {
      text: this.title,
    });

    const input = this.multiline
      ? contentEl.createEl("textarea", {
          cls: "kanban-add-input",
        })
      : contentEl.createEl("input", {
          type: "text",
          cls: "kanban-add-input",
        });
    if (this.placeholder) {
      input.setAttr("placeholder", this.placeholder);
    }
    if (this.multiline) {
      input.setAttr("rows", "3");
    }
    if (this.initialValue) {
      input.value = this.initialValue;
    }
    input.focus();

    const actions = contentEl.createDiv({ cls: "kanban-add-actions" });
    const addButton = actions.createEl("button", { text: this.submitLabel });
    const cancelButton = actions.createEl("button", { text: "Cancel" });

    const submit = (): void => {
      const value = input.value.replace(/\r\n/g, "\n").trim();
      if (!value) return;
      this.onSubmit(value);
      this.close();
    };

    addButton.addEventListener("click", submit);
    cancelButton.addEventListener("click", () => this.close());
    input.addEventListener("keydown", (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (
        keyboardEvent.key === "Enter" &&
        (!this.multiline || !keyboardEvent.shiftKey)
      ) {
        keyboardEvent.preventDefault();
        submit();
      }
      if (keyboardEvent.key === "Escape") this.close();
    });
  }
}

class ColorPromptModal extends Modal {
  private readonly title: string;
  private readonly submitLabel: string;
  private readonly onSubmit: (color: string) => void;
  private readonly initialValue: string;

  constructor(
    app: App,
    options: {
      title: string;
      submitLabel?: string;
      initialValue?: string;
      onSubmit: (color: string) => void;
    },
  ) {
    super(app);
    this.title = options.title;
    this.submitLabel = options.submitLabel ?? "Set";
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
      type: "color",
      cls: "kanban-color-input",
    });
    input.value = normalizeHexColor(this.initialValue) ?? "#64748b";
    input.focus();

    const actions = contentEl.createDiv({ cls: "kanban-add-actions" });
    const setButton = actions.createEl("button", { text: this.submitLabel });
    const cancelButton = actions.createEl("button", { text: "Cancel" });

    const submit = (): void => {
      this.onSubmit(input.value);
      this.close();
    };

    setButton.addEventListener("click", submit);
    cancelButton.addEventListener("click", () => this.close());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
      if (event.key === "Escape") this.close();
    });
  }
}

class DateTimePromptModal extends Modal {
  private readonly title: string;
  private readonly submitLabel: string;
  private readonly includeTime: boolean;
  private readonly initialDate: string;
  private readonly initialTime: string;
  private readonly onSubmit: (value: {
    nextDate: string;
    nextTime?: string;
  }) => void;

  constructor(
    app: App,
    options: {
      title: string;
      submitLabel?: string;
      includeTime: boolean;
      initialDate?: string;
      initialTime?: string;
      onSubmit: (value: { nextDate: string; nextTime?: string }) => void;
    },
  ) {
    super(app);
    this.title = options.title;
    this.submitLabel = options.submitLabel ?? "Set";
    this.includeTime = options.includeTime;
    this.initialDate = options.initialDate ?? "";
    this.initialTime = options.initialTime ?? "";
    this.onSubmit = options.onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.title });

    const dateInput = contentEl.createEl("input", {
      type: "date",
      cls: "kanban-add-input",
    });
    if (this.initialDate) dateInput.value = this.initialDate;

    let timeInput: HTMLInputElement | null = null;
    if (this.includeTime) {
      timeInput = contentEl.createEl("input", {
        type: "time",
        cls: "kanban-add-input",
      });
      if (this.initialTime) timeInput.value = this.initialTime;
    }

    const actions = contentEl.createDiv({ cls: "kanban-add-actions" });
    const submitButton = actions.createEl("button", { text: this.submitLabel });
    const cancelButton = actions.createEl("button", { text: "Cancel" });

    const submit = (): void => {
      const nextDate = dateInput.value.trim();
      if (!nextDate) return;
      const nextTime = timeInput?.value.trim();
      this.onSubmit({
        nextDate,
        nextTime: nextTime || undefined,
      });
      this.close();
    };

    submitButton.addEventListener("click", submit);
    cancelButton.addEventListener("click", () => this.close());
    dateInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
      if (event.key === "Escape") this.close();
    });
    timeInput?.addEventListener("keydown", (event) => {
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
        "Folder for notes created from cards. Always uses a board-named subfolder.",
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
      .setName("Note subfolder pattern")
      .setDesc(
        'Pattern for the board subfolder name. Use "{board}" as the placeholder. Default hides folders with "._".',
      )
      .addText((text) =>
        text
          .setPlaceholder("._{board}")
          .setValue(this.plugin.settings.noteFolderPattern)
          .onChange(async (value) => {
            this.plugin.settings.noteFolderPattern =
              value.trim() || "._{board}";
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
