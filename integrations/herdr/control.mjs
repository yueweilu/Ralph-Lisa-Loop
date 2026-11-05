import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const actionFile = fileURLToPath(new URL("./actions.mjs", import.meta.url));

function show(action) {
  const result = spawnSync(process.execPath, [actionFile, action], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000,
  });
  try {
    const response = JSON.parse(result.stdout.trim());
    console.log(`${action}: ${response.status}${response.code ? ` (${response.code})` : ""}`);
    if (action === "doctor") console.log(JSON.stringify(response.checks, null, 2));
    if (action === "status" && response.snapshot?.status === "error")
      console.log(response.snapshot.message ?? response.snapshot.code);
    else if (action === "status" && response.snapshot) {
      const { host_state, turn, round, step, session_id } = response.snapshot;
      console.log(JSON.stringify({ host_state, turn, round, step, session_id,
        coordination: response.coordination }, null, 2));
    }
    if (action === "seat-preflight" && response.binding_plan) {
      const { workspace_id, seats } = response.binding_plan;
      console.log(JSON.stringify({ workspace_id, seats }, null, 2));
    }
    if (action === "recovery-check" && response.status === "review_required") {
      console.log(JSON.stringify({ lease_id: response.cli?.lease_id,
        plugin: response.plugin, plugin_warning: response.plugin_warning,
        deliveries: response.deliveries, seats: response.seats,
        coordinator_process: response.coordinator_process,
        continuation_blockers: response.continuation_blockers,
        restart_observation: response.restart_observation }, null, 2));
    }
    if (action === "rebind-check" && response.project)
      console.log(JSON.stringify({ old_lease_id: response.old_lease_id,
        recovery_id: response.recovery_id, generation: response.generation,
        coordinator_process: response.coordinator_process,
        continuation_blockers: response.continuation_blockers,
        binding_plan: response.binding_plan }, null, 2));
  } catch {
    console.log(`${action}: probe failed (${result.error?.code ?? result.status ?? "unknown"})`);
  }
}

console.log("Ralph-Lisa / Herdr control");
console.log("Read-only diagnostics. Start binds two seats; pause waits for automatic delivery to halt, resume rechecks RLL state and seat identities, stop releases the lease. Use the Herdr actions for control.");
show("doctor");
show("status");
show("seat-preflight");

if (process.stdin.isTTY) {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    const answer = (await input.question("[Enter] refresh  [q] quit > ")).trim().toLowerCase();
    if (answer === "q") break;
    show("doctor");
    show("status");
    show("seat-preflight");
    show("recovery-check");
    show("rebind-check");
  }
  input.close();
}
