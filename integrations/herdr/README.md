# Ralph-Lisa Herdr plugin (S3.4 preview)

This is the public-repository Herdr plugin, separate from the Claude Code plugin in `plugin/`. It needs Herdr 0.9.4 or later, Node.js 18 or later, and a Ralph-Lisa CLI with the S1 host commands.

## Current behavior

- `doctor` checks Herdr version, the Ralph-Lisa host contract, Claude/Codex Herdr integrations, and both agent CLI login states. It reports one JSON object with a setup code and individual checks.
- `status` reads one project's RLL snapshot. It takes the project from `settings.json` or the invoking Herdr workspace. It does not claim a host lease or change RLL state.
- `seat-preflight` verifies two existing Herdr agents named `ralph` (Claude) and `lisa` (Codex), their live Pane/Workspace IDs, readiness, and project path, then returns a proposed RLL binding without claiming a lease or writing a binding.
- The `control` pane shows these read-only views and can refresh them.
- `start` writes an exclusive local intent. If both `ralph` (Claude) and `lisa` (Codex) are already ready in the invoking workspace, it attaches to them. If neither exists, it creates a dedicated Herdr workspace, splits two panes, starts both agents, waits for interactive readiness, and rechecks their returned IDs. It then claims the RLL host lease, binds the seats, and heartbeats every five seconds. A second start for the same project is rejected.
- After binding, the coordinator prepares RLL generation zero. It polls the validated RLL snapshot and looks up each new committed receipt through `host receipt`. Only a receipt for the current lease, binding, session, generation, and expected role may trigger a prompt to the opposite verified Herdr Agent. A durable delivery intent is written before `agent prompt`; accepted deliveries advance a local cursor. A gap, identity change, ambiguous prompt result, or existing generation without recovery stops in `needs_reconcile` without automatic replay. This preview has no automatic recovery of a stopped coordinator.
- A blocked Agent startup emits `needs_input` with its workspace and pane ID while the coordinator waits up to two minutes for a person to handle the prompt. It does not accept trust, permission, login, or update prompts on the user's behalf. A partially existing or mismatched named seat fails closed. `stop` currently applies only after the lease becomes active. If startup times out or becomes uncertain, inspect the retained plugin record and Herdr panes before retrying; automatic cleanup and resume of a partial bootstrap are not implemented.
- `stop` sends a durable request to that coordinator and waits for the RLL lease release. It leaves Claude and Codex running. The released binding becomes stale. The Herdr action log, rather than the initial invocation response, confirms completion.
- `pause` and `resume` still return `S2_COORDINATOR_PENDING`; automatic candidate submission and restart recovery are not yet implemented. The current CLI source gate requires a human to review and confirm each candidate before `host commit`, so this preview does not deliver an unattended Ralph/Lisa loop.

`ready` means the read-only preflight passed at that moment. Claude/Codex can be detected from their terminal screens without Herdr integrations. The `integrations` checks remain visible because they are needed to resume the same Agent sessions after a Herdr server restart. `started` means the host lease, bindings, and generation baseline are active; `handed_off` is emitted only after Herdr accepts a receipt-driven prompt. RLL still labels seat verification `unverified`, because its CLI does not independently authenticate Herdr's returned IDs.

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

For the S3.4 trial, initialize a disposable RLL project, open it as a Herdr workspace, and invoke `ralph-lisa.loop.start`. When it creates a dedicated workspace, handle any Agent startup prompts in the reported panes. Check the action log for `started` and use `ralph-lisa host snapshot --project <abs> --json` to confirm the claimed lease, two bound seats, and `generation=0`. Review a Ralph candidate, run the CLI's `commit-check` and `confirm-candidate` gate, then `host commit`; expect one `handed_off` log and one prompt in Lisa's pane. Repeat with a Lisa `NEEDS_WORK` candidate and expect one prompt in Ralph's pane. Invoke `ralph-lisa.loop.stop` from the project workspace; confirm both action logs succeeded and the snapshot reports `host_state=unclaimed` and `binding_state=stale`. The two Agents remain running. Do not run this trial against a live tmux or manually managed session.

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

The tests exercise the real public CLI's committed receipt flow against temporary projects; fake Herdr and agent binaries make prompt delivery and readiness reproducible. A green test run is not a real two-Agent handoff in Herdr.

For the remaining running-Herdr checks, follow the [S2 live acceptance checklist](../../docs/herdr/s2-live-acceptance-2026-11-03.md) from a Herdr-managed pane.
