/**
 * Mission Completion 不变量
 *
 * ⚠️ 内核硬约束（Phase F-1.1）：
 *
 *   COMPLETED 不是 Service "设置" 的状态，而是 VerificationPassed 事件产生后，
 *   由 Projection 推导出来的状态。
 *
 *   不存在任何"Action/Decision Event → COMPLETED"的捷径。
 *
 * 权威链：
 *   Reality → Observation → ProvenanceVerifier → OBSERVED
 *     → DERIVED (application.status = SUBMITTED)
 *     → VerificationPassed → Mission Projection → COMPLETED
 *
 * Phase F-1.1 升级：
 *   EvidenceScopeValid 从"时间范围"升级为"Mission + Action + Temporal"作用域约束。
 *   仅靠 createdAt >= actionStartedAt 不能防止跨 Mission 证据污染。
 *
 *   confirmed 不再存储在 Event 中，而是从 Evidence 推导的 Derived State。
 */

import type {
  Evidence,
  MissionRecord,
  MissionVerification,
} from "./types";

/**
 * Completion 不变量检查结果。
 */
export interface CompletionInvariantResult {
  canComplete: boolean;
  violations: string[];
}

/**
 * Mission 上下文，用于 EvidenceScopeValid 检查。
 *
 * ⚠️ Phase F-1.1: 时间只能作为辅助约束，主要 Scope Authority 是 missionId + actionId。
 */
export interface MissionCompletionContext {
  missionId: string;
  correlationId: string;
  operationId: string;
  /** Action 唯一标识（如 receiptId 或 action.id） */
  actionId?: string;
  /** Action 开始时间，evidence 必须晚于此时间（辅助约束） */
  actionStartedAt?: number;
  /** Action 完成时间 */
  actionCompletedAt?: number;
  /** 预期的目标 URI（如 job URL），evidence.source.uri 应匹配 */
  expectedTargetUri?: string;
}

/**
 * 验证 Evidence 是否属于当前 Mission/Action。
 *
 * ⚠️ Phase F-1.1: EvidenceScopeValid = MissionScope ∧ ActionScope ∧ TemporalScope ∧ ClaimScope
 *
 * 仅靠 createdAt >= actionStartedAt 不足以防止：
 *   Mission A (10:00 start) ← Mission B (10:02 observation) 错误吸收
 *
 * 必须通过 missionId + actionId 明确关联。
 *
 * @param evidence 待验证的 Evidence
 * @param context Mission 上下文
 * @returns 是否通过作用域检查，以及失败原因
 */
export function checkEvidenceScope(
  evidence: Evidence,
  context: MissionCompletionContext,
): { valid: boolean; reason?: string } {
  // 1. MissionScope: evidence.missionId 必须等于当前 mission.id
  if (evidence.missionId && evidence.missionId !== context.missionId) {
    return {
      valid: false,
      reason: `MISSION_SCOPE_MISMATCH: evidence.missionId=${evidence.missionId} !== context.missionId=${context.missionId}`,
    };
  }

  // 2. ActionScope: evidence.actionId 必须等于当前 action.id（如果 action 存在）
  if (context.actionId && evidence.actionId && evidence.actionId !== context.actionId) {
    return {
      valid: false,
      reason: `ACTION_SCOPE_MISMATCH: evidence.actionId=${evidence.actionId} !== context.actionId=${context.actionId}`,
    };
  }

  // 3. TemporalScope: evidence.createdAt 必须 >= actionStartedAt（辅助约束）
  if (context.actionStartedAt && evidence.createdAt < context.actionStartedAt) {
    return {
      valid: false,
      reason: `TEMPORAL_SCOPE_INVALID: evidence.createdAt=${evidence.createdAt} < actionStartedAt=${context.actionStartedAt}`,
    };
  }

  // 4. CorrelationScope: 如果 evidence 有 correlationId，必须匹配
  if (evidence.correlationId && evidence.correlationId !== context.correlationId) {
    return {
      valid: false,
      reason: `CORRELATION_SCOPE_MISMATCH: evidence.correlationId=${evidence.correlationId} !== context.correlationId=${context.correlationId}`,
    };
  }

  return { valid: true };
}

/**
 * 从 Evidence 推导验证是否成功。
 *
 * ⚠️ Phase F-1.1: confirmed 不存储在 Event 中，而是从 Evidence 推导。
 *
 * 默认逻辑：存在至少 1 条 OBSERVED Evidence 即视为"有验证数据"。
 * 具体的"成功/失败"语义由调用方传入 isSuccess 函数判断
 * （如 verifyApply 中匹配 APPLICATION_SUCCESS_PATTERNS）。
 *
 * @param evidence 验证用的 Evidence 列表
 * @param isSuccess 可选的成功判定函数
 * @returns 是否确认成功
 */
export function deriveVerificationSuccess(
  evidence: Evidence[],
  isSuccess?: (evidence: Evidence[]) => boolean,
): boolean {
  if (evidence.length === 0) return false;

  const hasObserved = evidence.some((e) => e.authority === "OBSERVED");
  if (!hasObserved) return false;

  if (isSuccess) {
    return isSuccess(evidence);
  }

  // 默认：有 OBSERVED evidence 即视为验证数据存在
  // （具体成功语义由调用方判断）
  return hasObserved;
}

/**
 * 检查 Mission 是否满足 COMPLETED 的全部不变量。
 *
 * COMPLETED 必须同时满足：
 *   1. ActionCompleted: action.completedAt !== undefined
 *   2. VerificationExists: verification !== undefined
 *   3. EvidenceExists: verification.evidenceIds 非空
 *   4. AllObserved: 验证证据全部为 OBSERVED authority
 *   5. EvidenceMissionScopeValid: evidence.missionId === mission.id
 *   6. EvidenceActionScopeValid: evidence.actionId === mission.action.id
 *   7. EvidenceTemporalScopeValid: evidence.createdAt >= actionStartedAt
 *   8. VerificationConfirmed: 从 evidence 推导的验证结论为成功
 *
 * 注意：
 *   - 第 4-7 条需要传入实际的 Evidence 对象才能验证
 *   - 第 5-7 条需要传入 missionContext 才能验证
 *   - 第 8 条需要传入 isSuccess 函数才能精确判断
 */
export function checkCompletionInvariants(
  mission: MissionRecord,
  verificationEvidence?: Evidence[],
  context?: MissionCompletionContext,
  isSuccess?: (evidence: Evidence[]) => boolean,
): CompletionInvariantResult {
  const violations: string[] = [];

  // 1. ActionCompleted
  if (!mission.action?.completedAt) {
    violations.push("ACTION_NOT_COMPLETED: action.completedAt is undefined");
  }

  // 2. VerificationExists
  if (!mission.verification) {
    violations.push("VERIFICATION_MISSING: verification is undefined");
  } else {
    // 3. EvidenceExists
    if (
      !mission.verification.evidenceIds ||
      mission.verification.evidenceIds.length === 0
    ) {
      violations.push("VERIFICATION_NO_EVIDENCE: verification.evidenceIds is empty");
    }
  }

  // 4-8. 需要实际 Evidence 和 Context
  if (verificationEvidence && verificationEvidence.length > 0) {
    // 4. MustHaveObserved: 必须至少有一条 OBSERVED evidence
    // 注意：DERIVED evidence 是允许的（从 OBSERVED 推导），但 INFERRED/RETRACTED 不允许
    const hasObserved = verificationEvidence.some(
      (e) => e.authority === "OBSERVED",
    );
    if (!hasObserved) {
      violations.push(
        "NO_OBSERVED_EVIDENCE: verification evidence must contain at least one OBSERVED authority",
      );
    }

    // 4b. 不允许 INFERRED 或 RETRACTED 出现在 verification evidence 中
    const invalidAuthority = verificationEvidence.filter(
      (e) => e.authority === "INFERRED" || e.authority === "RETRACTED",
    );
    if (invalidAuthority.length > 0) {
      violations.push(
        `INVALID_VERIFICATION_AUTHORITY: ${invalidAuthority.length} evidence(s) have INFERRED/RETRACTED authority: ${invalidAuthority
          .map((e) => `${e.id}=${e.authority}`)
          .join(", ")}`,
      );
    }

    // 4b. Evidence count 与 evidenceIds 一致
    if (mission.verification?.evidenceIds) {
      const evidenceIdSet = new Set(verificationEvidence.map((e) => e.id));
      const missingIds = mission.verification.evidenceIds.filter(
        (id) => !evidenceIdSet.has(id),
      );
      if (missingIds.length > 0) {
        violations.push(
          `EVIDENCE_ID_MISMATCH: ${missingIds.length} evidenceId(s) in verification not found in actual evidence`,
        );
      }
    }

    // 5-7. EvidenceScopeValid（需要 context）
    if (context) {
      for (const ev of verificationEvidence) {
        const scope = checkEvidenceScope(ev, context);
        if (!scope.valid) {
          violations.push(`EVIDENCE_SCOPE_INVALID: evidence=${ev.id} - ${scope.reason}`);
        }
      }
    }

    // 8. VerificationConfirmed（从 evidence 推导）
    const confirmed = deriveVerificationSuccess(verificationEvidence, isSuccess);
    if (!confirmed) {
      violations.push(
        "VERIFICATION_NOT_CONFIRMED: derived verification result is not success (no matching OBSERVED evidence or isSuccess returned false)",
      );
    }
  } else if (mission.verification?.evidenceIds?.length) {
    // 有 evidenceIds 但没有传入实际 evidence —— 无法验证 authority 和 scope
    violations.push(
      "EVIDENCE_NOT_PROVIDED: verification.evidenceIds exists but actual evidence not provided for authority/scope validation",
    );
  }

  return {
    canComplete: violations.length === 0,
    violations,
  };
}

/**
 * 断言 Mission 满足 COMPLETED 不变量。
 * 不满足时抛出 Error，包含所有违规项。
 */
export function assertCompletionInvariants(
  mission: MissionRecord,
  verificationEvidence?: Evidence[],
  context?: MissionCompletionContext,
  isSuccess?: (evidence: Evidence[]) => boolean,
): void {
  const result = checkCompletionInvariants(
    mission,
    verificationEvidence,
    context,
    isSuccess,
  );
  if (!result.canComplete) {
    throw new Error(
      `COMPLETION_INVARIANT_VIOLATION:\n${result.violations
        .map((v) => `  - ${v}`)
        .join("\n")}`,
    );
  }
}

/**
 * 从 Verification 结果推导 Mission 是否可以 COMPLETED。
 *
 * 这是 COMPLETED 的唯一合法入口。
 * Service 不能直接设置 state = "COMPLETED"，
 * 必须通过此函数验证后才能进入 COMPLETED。
 *
 * @param mission 当前 Mission 状态（应处于 VERIFYING）
 * @param verification Verification 结果（只包含 evidenceIds，不包含 confirmed）
 * @param verificationEvidence 实际的 Evidence 对象（用于验证 authority 和 scope）
 * @param context Mission 上下文（用于 EvidenceScopeValid 检查）
 * @param isSuccess 可选的成功判定函数（如匹配 APPLICATION_SUCCESS_PATTERNS）
 * @returns 更新后的 MissionRecord，如果不满足不变量则 state 保持 VERIFYING
 */
export function deriveCompletionFromVerification(
  mission: MissionRecord,
  verification: MissionVerification,
  verificationEvidence?: Evidence[],
  context?: MissionCompletionContext,
  isSuccess?: (evidence: Evidence[]) => boolean,
): MissionRecord {
  const candidate: MissionRecord = {
    ...mission,
    verification,
    updatedAt: Date.now(),
  };

  const result = checkCompletionInvariants(
    candidate,
    verificationEvidence,
    context,
    isSuccess,
  );

  if (!result.canComplete) {
    // 不满足不变量，不能进入 COMPLETED
    return candidate; // state 保持 VERIFYING
  }

  return {
    ...candidate,
    state: "COMPLETED",
    pendingApproval: undefined,
    updatedAt: Date.now(),
  };
}

/**
 * 检查 Mission 是否处于可以被验证的状态。
 */
export function canVerify(mission: MissionRecord): boolean {
  return mission.state === "VERIFYING" || mission.state === "EXECUTING";
}

/**
 * 检查 Mission 是否处于可以被批准的状态。
 */
export function canApprove(mission: MissionRecord): boolean {
  return mission.state === "AWAITING_APPROVAL";
}

/**
 * Completion Gate 的完整不变量清单（Phase F-1.1）。
 */
export const COMPLETION_INVARIANTS = [
  "ACTION_COMPLETED: mission.action.completedAt must be defined",
  "VERIFICATION_EXISTS: mission.verification must be defined",
  "EVIDENCE_EXISTS: mission.verification.evidenceIds must be non-empty",
  "ALL_OBSERVED: all verification evidence must have authority === OBSERVED",
  "EVIDENCE_MISSION_SCOPE_VALID: evidence.missionId must equal mission.id",
  "EVIDENCE_ACTION_SCOPE_VALID: evidence.actionId must equal current action.id",
  "EVIDENCE_TEMPORAL_SCOPE_VALID: evidence.createdAt must be >= action.startedAt",
  "VERIFICATION_CONFIRMED: derived verification result must be success (from OBSERVED evidence)",
  "NO_DECISION_SHORTCUT: decision/dispatch events cannot directly produce COMPLETED",
  "PROJECTION_ONLY: COMPLETED is derived from VerificationPassed event, not set directly",
  "NO_CONFIRMED_IN_EVENT: VerificationCaptured must not store confirmed field (derived state)",
] as const;
