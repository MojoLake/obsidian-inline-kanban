# Inline Kanban (Obsidian)

Render multiple kanban boards inside a single note using fenced code blocks.

## Usage

Create a fenced code block with the `kanban` language:

````
```kanban
columns:
  - Todo
  - Doing
  - Done
items:
  - [Todo] Write outline
  - [Doing] Implement parser
  - [Done] Ship
```
````

You can place any normal Markdown before, between, or after kanban blocks.
WIP limits can be added to column names like `In Progress (5)`.

## Interactions

- Use the `+` button in a column header to add a card.
- Drag cards between columns to change status.
- Drag cards within a column to reorder.
- Use "Add column" to append a new column.
- Drag the `:::` handle to reorder columns.
- Right-click a card to create a note from it.
- Double-click a column title or card to rename it.
- Use the card context menu to add `@YYYY-MM-DD` or `@@HH:mm`.

## Commands

- `Kanban: Create new Kanban board` creates a new board in the vault root.
- `Kanban: Convert empty note to Kanban` converts the current empty note.
- Right-click a folder to create a new board inside it.

## Development

```bash
npm install
npm run dev
```

Build and deploy to your vault:

```bash
npm run build
npm run deploy
```

By default `npm run deploy` targets `~/e/"Obsidian Vault"`. Override with
`OBSIDIAN_VAULT_PATH=/path/to/vault`.
