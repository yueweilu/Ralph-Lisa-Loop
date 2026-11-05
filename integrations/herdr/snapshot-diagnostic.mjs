const STATUS = /^[a-z][a-z0-9_]{0,31}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function safeToken(value, pattern) {
  if (value == null) return null;
  return typeof value === "string" && pattern.test(value) ? value : "unrecognized";
}

export function requireActiveSnapshot(result, paths, record, plan) {
  const value = result.value;
  const checks = [
    ["cli.exit_status", result.code === 0],
    ["status", value?.status === "ok"],
    ["project_realpath", value?.project_realpath === paths.real],
    ["session_id", value?.session_id === record.session_id],
    ["host_state", value?.host_state === "claimed"],
    ["owner_id", value?.owner_id === record.owner_id],
    ["binding_state", value?.binding_state === "bound"],
    ["binding_generation", value?.binding_generation === record.binding_generation],
    ["workspace_id", value?.workspace_id === plan.workspace_id],
    ["seats.ralph.pane_id", value?.seats?.ralph?.pane_id === plan.seats.ralph.pane_id],
    ["seats.lisa.pane_id", value?.seats?.lisa?.pane_id === plan.seats.lisa.pane_id],
    ["generation", Number.isSafeInteger(value?.generation) && value.generation >= 0],
  ];
  const unmatchedFields = checks.filter(([, matches]) => !matches).map(([field]) => field);
  if (unmatchedFields.length) {
    const reportedCode = safeToken(value?.code, CODE);
    const error = new Error(reportedCode && reportedCode !== "unrecognized" ?
      reportedCode : "ACTIVE_SNAPSHOT_MISMATCH");
    error.snapshot_diagnostic = {
      cli_exit_status: Number.isInteger(result.code) ? result.code : null,
      cli_result_status: safeToken(value?.status, STATUS),
      cli_result_code: safeToken(value?.code, CODE),
      cli_spawn_error: safeToken(result.error, CODE),
      unmatched_fields: unmatchedFields,
    };
    throw error;
  }
  return value;
}
