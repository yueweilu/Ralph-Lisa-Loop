# Ralph-Lisa Herdr plugin (S3.2 preview)

This is the public-repository Herdr plugin, separate from the Claude Code plugin in `plugin/`. It needs Herdr 0.9.4 or later, Node.js 18 or later, and a Ralph-Lisa CLI with the S1 host commands.

## Current behavior

- `doctor` checks Herdr version, the Ralph-Lisa host contract, Claude/Codex Herdr integrations, and both agent CLI login states. It reports one JSON object with a setup code and individual checks.
- `status` reads one project's RLL snapshot. It takes the project from `settings.json` or the invoking Herdr workspace. It does not claim a host lease or change RLL state.
- `seat-preflight` verifies two existing Herdr agents named `ralph` (Claude) and `lisa` (Codex), their live Pane/Workspace IDs, readiness, and project path, then returns a proposed RLL binding without claiming a lease or writing a binding.
- The `control` pane shows these read-only views and can refresh them.
- `start` attaches a long-running coordinator to the two **already running** Herdr agents. It writes an exclusive local intent, claims the RLL host lease, rechecks the project/session and Herdr seats, binds both seats, and heartbeats every five seconds. A second start for the same project is rejected.
- `stop` sends a durable request to that coordinator and waits for the RLL lease release. It leaves Claude and Codex running. The released binding becomes stale. The Herdr action log, rather than the initial invocation response, confirms completion.
- `pause` and `resume` still return `S2_COORDINATOR_PENDING`; message delivery, candidate submission, turn handoff, and restart recovery are not yet implemented.

`ready` means the read-only preflight passed at that moment. Claude/Codex can be detected from their terminal screens without Herdr integrations. The `integrations` checks remain visible because they are needed to resume the same Agent sessions after a Herdr server restart. `started` means the host lease and bindings are active; it does not mean automatic handoff has started. RLL still labels seat verification `unverified`, because its CLI does not independently authenticate Herdr's returned IDs.

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

Without `project`, a Herdr workspace action uses the absolute `workspace_cwd` from `HERDR_PLUGIN_CONTEXT_JSON`, checking it against `HERDR_WORKSPACE_ID` when both are provided. Without `rll_cli_argv`, the plugin resolves `ralph-lisa` on `PATH`. The project must already be initialized for `status` to return a snapshot. `settings.json` must be a regular file; malformed values return `INVALID_SETTINGS`.

Then run `herdr plugin action invoke ralph-lisa.loop.doctor`, inspect `herdr plugin log list --plugin ralph-lisa.loop`, and open the read-only pane with `herdr plugin pane open --plugin ralph-lisa.loop --entrypoint control --placement tab` from a Herdr workspace. Action invocation is asynchronous; the command log carries the result. `herdr plugin unlink ralph-lisa.loop` unregisters the local link.

For the S3.2 lease trial, initialize a disposable RLL project, open it as a Herdr workspace, start agents named `ralph` (Claude) and `lisa` (Codex) in separate panes, and run `seat-preflight`. When it reports `ready`, invoke `ralph-lisa.loop.start`; check its log for `started` and use `ralph-lisa host snapshot --project <abs> --json` to confirm the claimed lease and two bound seats. Invoke `ralph-lisa.loop.stop`; confirm both action logs succeeded and the snapshot reports `host_state=unclaimed` and `binding_state=stale`. Do not run this trial against a live tmux or manually managed session.

If the coordinator or Herdr server crashes, the RLL lease remains claimed. Do not delete the lease or rerun `start` blindly. Inspect the plugin state directory and `ralph-lisa host recovery-check --project <abs> --json`; recover only after checking that the old coordinator and agents are stopped and no submission is in flight. The plugin has no automatic lease takeover.

Herdr plugin installation and enabled state are global for the current user across Herdr sessions that use the same Herdr user directories. `HERDR_CONFIG_PATH` only changes the config file path; it does **not** isolate the plugin registry. For a disposable registration check on macOS with Herdr 0.9.4, setting **both** `XDG_CONFIG_HOME` and `XDG_STATE_HOME` to a temporary directory was verified to isolate the linked plugin from the normal Herdr plugin list:

```sh
HERDR_TEST_ROOT="$(mktemp -d)"
XDG_CONFIG_HOME="$HERDR_TEST_ROOT" XDG_STATE_HOME="$HERDR_TEST_ROOT" \
  herdr plugin link /absolute/path/to/Ralph-Lisa-Loop-herdr/integrations/herdr
XDG_CONFIG_HOME="$HERDR_TEST_ROOT" XDG_STATE_HOME="$HERDR_TEST_ROOT" \
  herdr plugin list --json
```

Keep the same two variables on the Herdr test server and subsequent CLI calls. `plugin link` validates the manifest without a running server; listing/invoking actions and opening panes need a running server. Do not infer that linking alone executed `doctor` or started Agents.

## Development check

```sh
cd cli && npm run build
cd .. && node --test integrations/herdr/actions.test.mjs integrations/herdr/coordinator.test.mjs
```

The tests exercise the real public CLI's host contract and snapshot against temporary projects; fake Herdr and agent binaries make readiness cases reproducible. A green test run is not a successful `plugin link` or a real two-Agent handoff.

For the remaining running-Herdr checks, follow the [S2 live acceptance checklist](../../docs/herdr/s2-live-acceptance-2026-11-03.md) from a Herdr-managed pane.
