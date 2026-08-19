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
 * 第一版最小 Policy。
 *
 * 后续应该把现有 SCA rule-engine / UserConstitution
 * 通过 Adapter 接入，而不是复制一套规则。
 */
export class DefaultPolicyEngine implements PolicyEngine {
  async evaluate(
    context: PolicyContext,
    request?: ApplyRequest,
  ): Promise<PolicyDecision> {
    if (context.action !== "APPLY") {
      return {
        effect: "ALLOW",
        reason: "Read-only capability does not require approval.",
      };
    }

    if (request?.approvalToken) {
      return {
        effect: "ALLOW",
        reason: "Explicit approval token supplied.",
      };
    }

    return {
      effect: "APPROVAL_REQUIRED",
      reason: "External side effect requires runtime approval.",
      approval: {
        missionId: "pending",
        reason: "Job application is an external side effect.",
        requestedAt: Date.now(),
      },
    };
  }
}
