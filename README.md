# Tempo UI

In an assembled workspace, run `make build-ui` from its root. In a standalone
source checkout, run `python3 -B tools/development_guard.py && npm ci && npm run build`.
The preflight protects the managed installation before installing dependencies
and again before building. The host serves `dist/index.html` and the bundled `dist/assets/`. The UI installs its locked Core package from `vendor/`, so a sibling Core checkout is unnecessary. The Core package contains corresponding sources and notices for the bundled board and pieces.

The matched Tempo server accepts v4 JSON commands at `/api/study` and `/api/repertoires`. `study_controller.js` validates study replies, persists an exact mutation before delivery, and recovers it with the same submission ID on reload. With no pending command, the backend chooses or resumes the current durable activity.

`StudyBoard.jsx` translates legal UCI moves supplied by Tempo into Core board destinations. Teaching adds a server-provided move and optional source comments. The learner reproduces the move before acknowledging; the server persists teaching as an ungraded activity. Promotion choice stays local until the learner picks a piece. Scheduled tests use the same board with no lesson data.

`RepertoiresPage.jsx` sends uploaded and pasted PGN through the same preview and save commands. Preview freezes the exact input, destination and server token used by save. Pending saves use separate tab storage from editable form inputs.

Run `npm test` for the wire and controller scenarios.

## Delivery diagnostics

Every JSON request from the desktop and phone has a new `X-Tempo-Request-Id`.
It identifies that delivery attempt; retrying a saved command keeps its original
body and durable command ID. Diagnostics observe delivery and never establish
whether a command was accepted or change which command is retried. Existing
five-second reads, ten-second Study acknowledgements, and caller-owned waits
are unchanged.

The browser keeps its latest 500 diagnostic events in memory. Each request
records its known route, method, time to response headers, body-reading time,
HTTP status, and final delivery outcome. A timeout records whether it happened
before headers or during the body, its request ID, and how late the local
deadline callback ran. A delayed callback can reflect a busy browser, tab
suspension, or machine contention; it is evidence rather than proof of a cause.
Late responses and bodies cannot replace the recorded timeout. An HTTP 200
reply containing an application error remains distinguishable from successful
delivery of an ordinary reply.

Choose **Download diagnostics** beside a Study error or in the Games header.
From any page, `window.tempoDiagnostics.download()` does the same, and
`window.tempoDiagnostics.snapshot()` returns the bounded snapshot. Export works
without contacting Tempo, including while its server is unresponsive. The
download contains no PGN, FEN, answers, commands, command IDs, account names,
query parameters, raw server messages, or credentials. Unknown routes become
`other`; diagnostic header values are restricted to the generated ID formats.
The export includes discarded-event counts. It resets when the page reloads.

Matching servers echo the delivery ID, their run ID, and an optional
`Server-Timing: tempo;dur=<milliseconds>` header. Older servers remain compatible
and simply omit those observations. No new response-body field or persisted
recovery envelope is required. Logging and download failures do not alter
transport outcomes. `test/diagnostics.test.js` exercises real transport stalls,
late replies, cancellation, bounded redacted exports, and failed recording;
the existing content/phone transport tests cover exact-command retry behavior.

`TacticsCapturePage.jsx` previews every pasted or uploaded PGN record and saves only selected valid rows. For a complete game, choose the variation and first and last solution moves. The server shows the normalized solver position and solution before capture. The same recovery convention keeps an unresolved capture separate from any editable PGN.

After required Study is complete, the UI offers practice from introduced tactics and an explicit increase to today's tactics allowance when those actions are available.

Run the repertoire editor browser check from the assembled workspace with
`node tempo-ui/test/repertoire_editor_browser.mjs`. It uses Chrome and a
disposable SQLite database through the guarded Make launcher. Make Playwright
available to Node or set `TEMPO_PLAYWRIGHT` to its installed module path.

## Game detector acceptance

Game history can open a read-only detector panel for the selected stored game
and player perspective. Detectors are registered at the Tempo host boundary;
the built-in hanging-material detector is available when its engine is
configured. The panel displays findings and their positions without issuing
dataset mutations.

The Games page also displays durable hanging-piece history from
`POST /api/games/tactics`. Counts describe observed decisions: a good capture
taken, an equally good alternative, a missed good capture, an inferior capture
taken or declined, or an uncertain comparison. They do not infer what the
learner recognized. Selected observations show the source position, played
move, candidate capture scores, and the single Stockfish-selected capture when
the current analysis proposes a puzzle. Recorded Study card status is separate:
an issued or fulfilled card can retain its earlier answer when later analysis
revises the finding. Inferior captures remain comparison records.

History reads have a five-second deadline and repeat three seconds after each
completed read while mounted. Unmount, dataset replacement, and page changes
abort the previous owner. Unavailability stops polling until Refresh; transient
failures retain the last successful page with an explicit stale notice. Each
page contains at most 30 observations, with explicit Earlier and Latest
navigation. Opening a source game uses its zero-based pre-move occurrence
directly. This view never submits Study or capture commands; automatic puzzle
creation and immediate review requests belong to the server's background game
analysis.

`test/tactical_history.test.js` covers the typed read contract and legal board
facts. `test/tactical_history_mounted.test.js` mounts the production component
and Core board to verify outcome presentation, source navigation, pagination,
polling recovery, and cancellation of late replies.

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

## Phone Study

The build also emits the standalone phone Study bundle under `dist/phone`.
The desktop and phone bundles share the Study session and use the same API.
Both use the bounded Study transport and immutable command recovery. Phone
connection hints preserve structured server errors. Desktop owns game links
and browser navigation; the phone entry contains only Study.
After building the matching Tempo binary and UI, run
`node tempo-ui/test/phone_study_browser.mjs` from the assembled workspace
with Playwright WebKit installed. The test uses a disposable database.
