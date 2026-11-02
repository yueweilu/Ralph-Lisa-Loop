# Ralph-Lisa Herdr plugin (S2 preview)

This is the public-repository Herdr plugin, separate from the Claude Code plugin in `plugin/`. It needs Herdr 0.9.4 or later, Node.js 18 or later, and a Ralph-Lisa CLI with the S1 `host inspect` and `host snapshot` commands.

## Current behavior

- `doctor` checks Herdr version, the Ralph-Lisa host contract, Claude/Codex Herdr integrations, and both agent CLI login states. It reports one JSON object with a setup code and individual checks.
- `status` reads one project's RLL snapshot. It takes the project from `settings.json` or the invoking Herdr workspace. It does not claim a host lease or change RLL state.
- The `control` pane shows these two read-only views and can refresh them.
- `start`, `pause`, `resume`, and `stop` are declared for a stable action surface, but currently return `S2_COORDINATOR_PENDING` with exit code 4. They do not start an Agent or mutate a project. The S3 coordinator must implement those actions and bind the real Herdr workspace, pane and Agent IDs to RLL's host contract.

`ready` means the read-only preflight passed at that moment. It does not mean a dual-Agent workflow has started or that real task delivery has been verified.

## Local setup

Build the public CLI first (`cd cli && npm ci && npm run build`) or install a published CLI containing the S1 host commands. From this checkout, link the plugin:

```sh
herdr plugin link /absolute/path/to/Ralph-Lisa-Loop-herdr/integrations/herdr
herdr plugin config-dir ralph-lisa.loop
```

The second command prints the per-plugin config directory. An optional `settings.json` there can pin an absolute project and CLI argv:

```json
{
  "project": "/absolute/path/to/your/project",
  "rll_cli_argv": ["node", "/absolute/path/to/Ralph-Lisa-Loop-herdr/cli/dist/cli.js"]
}
```

Without `project`, a Herdr workspace action uses `HERDR_WORKSPACE_ID`. Without `rll_cli_argv`, the plugin resolves `ralph-lisa` on `PATH`. The project must already be initialized for `status` to return a snapshot. `settings.json` must be a regular file; malformed values return `INVALID_SETTINGS`.

Then run `herdr plugin action invoke ralph-lisa.loop.doctor`, inspect `herdr plugin log list --plugin ralph-lisa.loop`, and open the read-only pane with `herdr plugin pane open --plugin ralph-lisa.loop --entrypoint control --placement split` from a Herdr workspace. Action invocation is asynchronous; the command log carries the result. `herdr plugin unlink ralph-lisa.loop` unregisters the local link.

Herdr plugin installation and enabled state are global for the current user across Herdr sessions. `HERDR_CONFIG_PATH` only changes the config file path; it does **not** isolate this plugin registry. Use a disposable OS user when an isolated registration test is required.

## Development check

```sh
cd cli && npm run build
cd .. && node --test integrations/herdr/actions.test.mjs
```

The tests exercise the real public CLI's host contract and snapshot against temporary projects; fake Herdr and agent binaries make readiness cases reproducible. A green test run is not a successful `plugin link` or a real two-Agent handoff.
