# Tempo UI

Run `npm ci` and `npm run build` here. The host serves `dist/index.html` and the bundled `dist/assets/`. The UI installs its locked Core package from `vendor/`, so a sibling Core checkout is unnecessary. The Core package contains corresponding sources and notices for the bundled board and pieces.

The matched Tempo server accepts v4 JSON commands at `/api/study` and `/api/repertoires`. `study_controller.js` validates study replies, persists an exact mutation before delivery, and recovers it with the same submission ID on reload. With no pending command, the backend chooses or resumes the current durable activity.

`StudyBoard.jsx` translates legal UCI moves supplied by Tempo into Core board destinations. Teaching adds a server-provided move and optional source comments. The learner reproduces the move before acknowledging; the server persists teaching as an ungraded activity. Promotion choice stays local until the learner picks a piece. Scheduled tests use the same board with no lesson data.

`RepertoiresPage.jsx` sends uploaded and pasted PGN through the same preview and save commands. Preview freezes the exact input, destination and server token used by save. Pending saves use separate tab storage from editable form inputs.

Run `npm test` for the wire and controller scenarios.
