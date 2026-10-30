/** Shared, side-effect-free submission checks for the CLI and future host commit. */
import { checkNeedsWorkResponse, getPolicyMode, runPolicyCheck, type PolicyViolation } from "./policy.js";
import { extractTag } from "./state.js";

export type SubmissionRole = "ralph" | "lisa";
export type SubmissionFailure = "wrong_turn" | "invalid_tag" | "policy" | "needs_work";

export interface SubmissionCheck {
  tag: string;
  failure: SubmissionFailure | null;
  violations: PolicyViolation[];
  needsWorkWarnings: PolicyViolation[];
}

/** Preserve the existing order: turn, tag, policy, then Ralph's NEEDS_WORK rule. */
export function checkSubmission(
  role: SubmissionRole,
  content: string,
  turn: string,
  lastLisaTag = ""
): SubmissionCheck {
  if (turn !== role) {
    return { tag: "", failure: "wrong_turn", violations: [], needsWorkWarnings: [] };
  }

  const tag = extractTag(content);
  if (!tag) {
    return { tag, failure: "invalid_tag", violations: [], needsWorkWarnings: [] };
  }

  const policy = runPolicyCheck(role, tag, content);
  if (!policy.proceed) {
    return { tag, failure: "policy", violations: policy.violations, needsWorkWarnings: [] };
  }

  const needsWork = role === "ralph" && getPolicyMode() !== "off"
    ? checkNeedsWorkResponse(tag, lastLisaTag)
    : [];
  if (needsWork.length > 0 && getPolicyMode() === "block") {
    return { tag, failure: "needs_work", violations: needsWork, needsWorkWarnings: [] };
  }
  return {
    tag,
    failure: null,
    violations: [...policy.violations, ...needsWork],
    needsWorkWarnings: needsWork,
  };
}
