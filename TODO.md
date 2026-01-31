# TODO

## Now

- [x] ability to remove notes
- [x] when dragging note and get to the "end" of the screen, start scrolling in the correct way

## Next improvements

- [x] Preserve original kanban block formatting when updating
- [x] Reorder cards within a column
- [x] Add an "Add column" button
- [x] Reorder columns by dragging headers
- [x] Inline edit / rename cards
- [x] Dev watch + auto-deploy
- [x] Command to add a new kanban board in the current page.

## Next on TODO

- [x] Create new board via command / context menu
- [x] Convert empty note into a kanban board
- [x] Create a new note from a card (note folder + template)
- [x] WIP limits in column titles (e.g. `In Progress (5)`)
- [x] Date and time pickers for cards via triggers / menu
- [ ] Image embeds on cards + metadata-driven card images
- [ ] Archive section + toggle between kanban and markdown view
- [ ] Search within a board using standard find

- [ ] Optional card metadata rendering: tags (e.g. `#foo/bar`) as pills, plus nicer date/time display for `@YYYY-MM-DD` / `@@HH:mm`
- [ ] Column sort modes: manual (current), by date/time then title, by title; per-column toggle
- [ ] Completed/archive workflow: "Mark complete" action that appends a completion token (and/or moves to a designated column), plus optional collapsed "Archive" section
- [ ] Board-local filtering: quick text filter and/or tag filter (no vault-wide indexing)
- [ ] Hide/show selected tags on cards (e.g. column-driving tags)
- [ ] Recognize Tasks/Dataview due formats for display/sort (e.g. `📅 2026-01-31`, `[due:: 2026-01-31]`) without changing stored text
- [ ] Multi-line card bodies: support indented lines under an item inside the `kanban` block (subtasks + notes) and render them on the card
