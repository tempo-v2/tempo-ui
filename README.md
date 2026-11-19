# Tempo UI

In an assembled workspace, run `make build-ui` from its root. In a standalone
source checkout, run `python3 -B tools/development_guard.py && npm ci && npm run build`.
The preflight protects the managed installation before installing dependencies
and again before building. The host serves `dist/index.html` and the bundled `dist/assets/`. The UI installs its locked Core package from `vendor/`, so a sibling Core checkout is unnecessary. The Core package contains corresponding sources and notices for the bundled board and pieces.

The matched Tempo server accepts v4 JSON commands at `/api/study` and `/api/repertoires`. `study_controller.js` validates study replies, persists an exact mutation before delivery, and recovers it with the same submission ID on reload. With no pending command, the backend chooses or resumes the current durable activity.

`StudyBoard.jsx` translates legal UCI moves supplied by Tempo into Core board destinations. Teaching adds a server-provided move and optional source comments. The learner reproduces the move before acknowledging; the server persists teaching as an ungraded activity. Promotion choice stays local until the learner picks a piece. Scheduled tests use the same board with no lesson data.

`RepertoiresPage.jsx` sends uploaded and pasted PGN through the same preview and save commands. Preview freezes the exact input, destination and server token used by save. Pending saves use separate tab storage from editable form inputs.

Run `npm test` for the wire and controller scenarios.

`TacticsCapturePage.jsx` previews every pasted or uploaded PGN record and saves only selected valid rows. For a complete game, choose the variation and first and last solution moves. The server shows the normalized solver position and solution before capture. The same recovery convention keeps an unresolved capture separate from any editable PGN.

After required Study is complete, the UI offers practice from introduced tactics and an explicit increase to today's tactics allowance when those actions are available.

Run the repertoire editor browser check from the assembled workspace with
`node tempo-ui/test/repertoire_editor_browser.mjs`. It uses Chrome and a
disposable SQLite database through the guarded Make launcher. Make Playwright
available to Node or set `TEMPO_PLAYWRIGHT` to its installed module path.

## Game detector acceptance

Game history can open a read-only detector panel for the selected stored game
and player perspective. The production registry is empty until a detector is
registered at the Tempo host boundary. Findings and their positions display
without writing to the dataset.

From the assembled workspace, build the production UI and both Tempo binaries,
then run:

```sh
make build-ui
cargo build --locked -p tempo --bin tempo --example game_detection_contract_host
node tempo-ui/test/game_detection_browser.mjs \
  target/debug/tempo target/debug/examples/game_detection_contract_host tempo-ui/dist
```

The runner uses a disposable SQLite database, Chrome, and the built UI served
by the production host with an external fixture detector. Playwright can be
resolved by Node or specified with `TEMPO_PLAYWRIGHT`.
