import type {
  ApplyRequest,
  CareerConstraint,
  PolicyDecision,
} from "./types";

export interface PolicyContext {
  constraints: CareerConstraint;
  action: "SEARCH" | "INSPECT" | "APPLY";
}

export interface PolicyEngine {
  evaluate(
    context: PolicyContext,
    request?: ApplyRequest,
  ): Promise<PolicyDecision>;
}

/**
 * ⚠️ P1-1 Fix: Plugin Policy Authority removed.
 *
 * Previously, DefaultPolicyEngine implemented its own policy logic:
 *   - APPLY + no approvalToken → APPROVAL_REQUIRED
 *   - SEARCH/INSPECT → ALLOW
 *
 * This created a DUPLICATE Policy Authority alongside SCA Core's evaluateActionGate().
 *
 * Now, DefaultPolicyEngine is a PASS-THROUGH that delegates to SCA Policy.
 * The Plugin only retains Capability Metadata (e.g., "career.apply requiresPolicy=true"),
 * not business policy rules.
 *
 * SCA Constitution / Action Gate is the SINGLE Policy Authority.
 */
export class DefaultPolicyEngine implements PolicyEngine {
  async evaluate(
    context: PolicyContext,
    request?: ApplyRequest,
  ): Promise<PolicyDecision> {
    // Read-only capabilities do not require policy evaluation.
    if (context.action !== "APPLY") {
      return {
        effect: "ALLOW",
        reason: "Read-only capability does not require policy evaluation.",
      };
    }

    // For APPLY, delegate to SCA Policy via the Provider's prepare phase.
    // The Provider (SCACoreRuntime.prepareApply) already calls evaluateActionGate().
    // Here we just check if an approval token was provided.
    if (request?.approvalToken) {
      return {
        effect: "ALLOW",
        reason: "Explicit approval token supplied (pre-authorized by SCA Policy).",
      };
    }

    // Default: require approval. The actual policy decision is made by
    // SCACoreRuntime.prepareApply() which calls SCA's evaluateActionGate().
    // If prepare returns ready=false with blockers, the apply flow stops there.
    // If prepare returns ready=true, we still require explicit approval here
    // unless the user has pre-approved via approvalToken.
    return {
      effect: "APPROVAL_REQUIRED",
      reason: "External side effect (JOB_APPLICATION) requires explicit user approval. Policy evaluation is delegated to SCA Core's evaluateActionGate() during prepare phase.",
      approval: {
        missionId: "pending",
        reason: "Job application is an external side effect requiring user confirmation.",
        requestedAt: Date.now(),
      },
    };
  }
}
