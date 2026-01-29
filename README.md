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
