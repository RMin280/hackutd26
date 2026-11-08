# hackutd26: Blast Radius

Air traffic control for datacenter work: every action is checked before it happens, and when a node in a big job fails, Blast Radius finds the real cause and a safe place to restart. New here? Read `HANDOFF.md`, then `DESIGN.md`.

## Run it

You need Node 22+ and the SpacetimeDB CLI 2.x (`curl -sSf https://install.spacetimedb.com | sh`).

```bash
bash dev.sh server     # terminal 1: local SpacetimeDB on :3000, leave it running
bash dev.sh up         # terminal 2: publish the backend, then start the view in live mode
```

Then open http://localhost:5173. A fresh database shows the diagnostics test bed; Space runs the demo scenario on the backend.

The first publish asks to log in with spacetimedb.com if the CLI isn't logged in yet: press Enter and finish in the browser (it's free and also works with the local server).

| Command | What it does |
| --- | --- |
| `bash dev.sh check` | What's installed and running (paste the output when asking for help) |
| `bash dev.sh publish` | Rebuild and republish the backend; keeps the data unless the schema changed |
| `bash dev.sh fresh` | Republish and wipe the data: back to the diagnostics test bed |
| `bash dev.sh frontend` | Regenerate the client bindings and start the view (backend already published) |
| `bash dev.sh test` | Backend tests (no SpacetimeDB needed) |

The same thing by hand, from the repo root:

```bash
spacetime start                                                   # terminal 1, leave it running
(cd spacetimedb && npm install)                                   # terminal 2
spacetime publish --server local --module-path spacetimedb blast-radius
(cd frontend && npm install && npm run bindings)
cp frontend/.env.example frontend/.env.local                      # live mode
(cd frontend && npm run dev)
```

After a breaking schema change, add `--delete-data` to the publish (it wipes the database and reloads the test bed). Without `frontend/.env.local` the view runs on its built-in mock, no backend needed.
