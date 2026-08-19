import type {
  ActionReceipt,
  ApplyPreparation,
  ApplyRequest,
  ApprovalDecision,
  CareerState,
  Evidence,
  JobInspectRequest,
  JobInspectResult,
  JobSearchRequest,
  JobSearchResult,
  MissionAction,
  MissionRecord,
  MissionState,
  MissionVerification,
  VerificationResult,
} from "../contract/types";
import {
  type MissionRepository,
} from "../contract/mission";
import {
  DefaultPolicyEngine,
  type PolicyEngine,
} from "../contract/policy";
import { EvidenceFactory } from "../contract/evidence";
import {
  deriveCompletionFromVerification,
  assertCompletionInvariants,
  type MissionCompletionContext,
} from "../contract/mission-completion";
import type { SCAProvider } from "../providers/types";

export interface CareerStateProvider {
  getCareerState(): Promise<CareerState>;
}

export interface CareerServiceDependencies {
  careerState: CareerStateProvider;
  provider: SCAProvider;
  /**
   * Mission 状态权威。
   *
   * ⚠️ 生产环境必须注入 SCAMissionRepository（Event Sourcing）。
   * InMemoryMissionRepository 仅用于 unit test，不能用于生产。
   */
  missionRepository: MissionRepository;
  policyEngine?: PolicyEngine;
  evidenceFactory?: EvidenceFactory;
}

function generateOperationId(): string {
  return `op_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export class CareerService {
  private readonly missions: MissionRepository;
  private readonly policy: PolicyEngine;
  private readonly evidence: EvidenceFactory;

  constructor(
    private readonly deps: CareerServiceDependencies,
  ) {
    // missionRepository 是必填依赖，生产必须注入 SCAMissionRepository
    this.missions = deps.missionRepository;

    this.policy =
      deps.policyEngine ?? new DefaultPolicyEngine();

    this.evidence =
      deps.evidenceFactory ?? new EvidenceFactory();
  }

  // ============================================================
  // Search —— 只读能力，不需要审批
  // ============================================================

  /**
   * ⚠️ P0-1 Fix: Search Completion is NOT the same as Apply Completion.
   *
   * Search completes when SearchResultCaptured (results exist), not when
   * VerificationPassed. This is a different completion path for read-only missions.
   *
   * Flow:
   *   CREATED → PLANNING → DISCOVERING → COLLECTING → EVALUATING → COMPLETED
   *
   * Completion invariant for JOB_SEARCH:
   *   - Results must be non-empty OR explicitly empty (no jobs found)
   *   - Evidence must have been collected (even if zero OBSERVED)
   */
  async search(
    request: JobSearchRequest,
  ): Promise<JobSearchResult> {
    const operationId = generateOperationId();

    const mission = await this.missions.create(
      "JOB_SEARCH",
      request,
      operationId,
      operationId,
    );

    await this.transition(mission.id, "PLANNING");

    const careerState =
      await this.deps.careerState.getCareerState();

    const effectiveRequest: JobSearchRequest = {
      ...request,
      constraints: {
        ...careerState.constraints,
        ...request.constraints,
      },
    };

    await this.transition(mission.id, "DISCOVERING");

    const result = await this.deps.provider.search.search(
      effectiveRequest,
    );

    await this.missions.checkpoint(mission.id, {
      resultCount: result.jobs.length,
      evidenceCount: result.evidence.length,
    });

    await this.transition(mission.id, "COLLECTING");
    await this.transition(mission.id, "EVALUATING");

    // ⚠️ P0-1: Search completion does NOT require OBSERVED verification.
    // It completes when results are captured (even if empty).
    // This is a READ-ONLY completion path, separate from Apply's VERIFYING → COMPLETED.
    await this.transition(mission.id, "COMPLETED");

    return {
      missionId: mission.id,
      state: "COMPLETED",
      results: result.jobs,
      total: result.jobs.length,
      hasMore: false,
    };
  }

  // ============================================================
  // Inspect —— 只读能力，不需要审批
  // ============================================================

  /**
   * ⚠️ P0-1 Fix: Inspection Completion is NOT the same as Apply Completion.
   *
   * Inspection completes when InspectionResultCaptured (job details obtained), not when
   * VerificationPassed. This is a different completion path for read-only missions.
   *
   * Flow:
   *   CREATED → PLANNING → COLLECTING → EVALUATING → COMPLETED
   *
   * Completion invariant for JOB_INSPECTION:
   *   - Job details must be captured (even if partial)
   *   - Evidence may include OBSERVED (from page observation) or DERIVED (from interpretation)
   */
  async inspect(
    request: JobInspectRequest,
  ): Promise<JobInspectResult> {
    const operationId = generateOperationId();

    const mission = await this.missions.create(
      "JOB_INSPECTION",
      request,
      operationId,
      operationId,
    );

    await this.transition(mission.id, "PLANNING");
    await this.transition(mission.id, "COLLECTING");

    const result =
      await this.deps.provider.inspection.inspect(
        request.jobId,
      );

    await this.transition(mission.id, "EVALUATING");

    // ⚠️ P0-1: Inspection completion does NOT require OBSERVED verification.
    // It completes when job details are captured.
    // This is a READ-ONLY completion path, separate from Apply's VERIFYING → COMPLETED.
    await this.transition(mission.id, "COMPLETED");

    return {
      ...result,
      missionId: mission.id,
    };
  }

  // ============================================================
  // Apply —— 外部副作用能力，必须经过 Policy + Approval + Verify
  // ============================================================

  /**
   * 发起投递请求。
   *
   * 流程：
   *   CREATE → PLANNING → prepare() → Policy Gate
   *     ├── ALLOW              → EXECUTING → execute() → VERIFYING → verify() → COMPLETED/FAILED
   *     ├── DENY               → FAILED
   *     └── APPROVAL_REQUIRED  → AWAITING_APPROVAL（等待 approve()/deny()）
   *
   * 注意：即使 Policy 返回 ALLOW，也必须经过 verify() 阶段。
   * "accepted: true" 不等于"现实世界已成功"。
   */
  async apply(
    request: ApplyRequest,
  ) {
    const operationId = generateOperationId();

    const mission = await this.missions.create(
      "JOB_APPLICATION",
      request,
      operationId,
      operationId,
    );

    await this.transition(mission.id, "PLANNING");

    // Phase 1: prepare —— 评估可行性，不产生副作用
    const preparation: ApplyPreparation =
      await this.deps.provider.application.prepare(
        request,
      );

    if (!preparation.ready) {
      await this.failMission(
        mission.id,
        "PREPARATION_BLOCKED",
        "PROVIDER",
        preparation.blockers?.join("; ") ??
          "Application preparation failed.",
      );

      return {
        missionId: mission.id,
        jobId: request.jobId,
        state: "FAILED" as MissionState,
        failure: {
          code: "PREPARATION_BLOCKED",
          category: "PROVIDER",
          message:
            preparation.blockers?.join("; ") ??
            "Application preparation failed.",
          recoverable: false,
          retryable: false,
        },
      };
    }

    // ⚠️ P0-4 Fix: Store jobId in checkpoint so execute/verify can retrieve it.
    // This separates Mission identity (mission.id) from Job entity identity (request.jobId).
    await this.missions.checkpoint(mission.id, {
      jobId: request.jobId,
      planId: preparation.planId,
      resumeId: request.resumeId,
      message: request.message,
    });

    // Phase 2: Policy Gate
    const careerState =
      await this.deps.careerState.getCareerState();

    const decision = await this.policy.evaluate(
      {
        action: "APPLY",
        constraints: careerState.constraints,
      },
      request,
    );

    if (decision.effect === "DENY") {
      await this.failMission(
        mission.id,
        "POLICY_DENIED",
        "POLICY",
        decision.reason,
      );

      return {
        missionId: mission.id,
        jobId: request.jobId,
        state: "FAILED" as MissionState,
        failure: {
          code: "POLICY_DENIED",
          category: "POLICY",
          message: decision.reason,
          recoverable: false,
          retryable: false,
        },
      };
    }

    if (decision.effect === "APPROVAL_REQUIRED") {
      const approval = decision.approval ?? {
        missionId: mission.id,
        reason: decision.reason,
        requestedAt: Date.now(),
      };

      // ⚠️ P0-4 Fix: Store jobId in checkpoint for later retrieval by execute/verify.
      await this.missions.update(mission.id, {
        state: "AWAITING_APPROVAL",
        pendingApproval: {
          ...approval,
          missionId: mission.id,
        },
        checkpoint: {
          jobId: request.jobId,
          planId: preparation.planId,
          resumeId: request.resumeId,
          message: request.message,
        },
      });

      return {
        missionId: mission.id,
        jobId: request.jobId,
        state: "AWAITING_APPROVAL" as MissionState,
        approvalRequired: true,
        reason: decision.reason,
        pendingApproval: {
          ...approval,
          missionId: mission.id,
        },
      };
    }

    // Policy ALLOW —— 直接执行（但仍需 verify）
    return this.executeAndVerify(
      mission.id,
      request.approvalToken,
    );
  }

  /**
   * 批准处于 AWAITING_APPROVAL 状态的 Mission。
   *
   * 流程：
   *   AWAITING_APPROVAL → EXECUTING → execute() → VERIFYING → verify() → COMPLETED/FAILED
   */
  async approve(
    missionId: string,
    approvalToken?: string,
  ) {
    const mission = await this.requireMission(missionId);

    if (mission.state !== "AWAITING_APPROVAL") {
      throw new Error(
        `INVALID_APPROVAL_STATE:${mission.state}`,
      );
    }

    return this.executeAndVerify(missionId, approvalToken);
  }

  /**
   * 拒绝处于 AWAITING_APPROVAL 状态的 Mission。
   *
   * 流程：
   *   AWAITING_APPROVAL → CANCELLED
   */
  async deny(
    missionId: string,
    reason?: string,
  ) {
    const mission = await this.requireMission(missionId);

    if (mission.state !== "AWAITING_APPROVAL") {
      throw new Error(
        `INVALID_APPROVAL_STATE:${mission.state}`,
      );
    }

    await this.missions.update(missionId, {
      state: "CANCELLED",
      pendingApproval: undefined,
      failure: reason
        ? {
            code: "APPROVAL_DENIED",
            category: "POLICY",
            message: reason,
            recoverable: false,
            retryable: false,
          }
        : undefined,
    });

    return {
      missionId,
      state: "CANCELLED" as MissionState,
      reason: reason ?? "Approval denied by user.",
    };
  }

  // ============================================================
  // Mission Control
  // ============================================================

  async getMission(
    id: string,
  ): Promise<MissionRecord | null> {
    return this.missions.get(id);
  }

  async pause(
    id: string,
  ): Promise<MissionRecord> {
    return this.transition(id, "PAUSED");
  }

  async cancel(
    id: string,
  ): Promise<MissionRecord> {
    return this.transition(id, "CANCELLED");
  }

  // ============================================================
  // Internal: execute + verify 闭环
  // ============================================================

  private async executeAndVerify(
    missionId: string,
    approvalToken?: string,
  ) {
    await this.transition(missionId, "EXECUTING");

    // ⚠️ P0-4 Fix: Read jobId from checkpoint for proper identity separation.
    const mission = await this.missions.get(missionId);
    const jobId = (mission?.checkpoint as any)?.jobId;

    const actionStart = Date.now();
    const action: MissionAction = {
      type: "JOB_APPLICATION",
      startedAt: actionStart,
    };
    await this.missions.update(missionId, { action });

    // Phase 3: execute —— 执行外部行动
    const receipt: ActionReceipt =
      await this.deps.provider.application.execute(
        missionId,
        approvalToken,
      );

    action.completedAt = Date.now();
    action.receiptId = receipt.receiptId;
    action.receipt = receipt;
    await this.missions.update(missionId, { action });

    if (!receipt.accepted) {
      await this.failMission(
        missionId,
        receipt.failure?.code ?? "APPLICATION_EXECUTION_FAILED",
        "PROVIDER",
        receipt.failure?.message ??
          "Application provider rejected the operation.",
      );

      return {
        missionId,
        jobId,
        state: "FAILED" as MissionState,
        verification: receipt.evidence,
        failure: {
          code:
            receipt.failure?.code ??
            "APPLICATION_EXECUTION_FAILED",
          category: "PROVIDER",
          message:
            receipt.failure?.message ??
            "Application execution failed.",
          recoverable: receipt.failure?.retryable ?? false,
          retryable: receipt.failure?.retryable ?? false,
        },
      };
    }

    // Phase 4: verify —— 基于 OBSERVED Evidence 确认现实世界状态
    await this.transition(missionId, "VERIFYING");

    const verification: VerificationResult =
      await this.deps.provider.application.verify(
        missionId,
      );

    // ⚠️ 关键边界：没有 OBSERVED 证据就不能 COMPLETED
    const hasObservedEvidence = verification.evidence.some(
      (e) => e.authority === "OBSERVED",
    );

    if (!verification.confirmed || !hasObservedEvidence) {
      await this.failMission(
        missionId,
        verification.failure?.code ?? "VERIFICATION_FAILED",
        "PROVIDER",
        verification.failure?.message ??
          verification.summary ??
          "Application could not be verified by observed evidence.",
      );

      return {
        missionId,
        state: "FAILED" as MissionState,
        verification: verification.evidence,
        failure: {
          code:
            verification.failure?.code ??
            "VERIFICATION_FAILED",
          category: "PROVIDER",
          message:
            verification.failure?.message ??
            verification.summary ??
            "Verification failed: no OBSERVED evidence confirming application status.",
          recoverable: verification.failure?.retryable ?? true,
          retryable: verification.failure?.retryable ?? true,
        },
      };
    }

    // ⚠️ Phase F-1.1: MissionVerification 不存储 confirmed 字段。
    // confirmed 是从 Evidence 推导的 Derived State，不是历史事实。
    // Completion Gate 会通过 isSuccess 函数从 evidence 推导验证结论。
    const missionVerification: MissionVerification = {
      evidenceIds: verification.evidence.map((e) => e.id),
      verifiedAt: Date.now(),
      summary: verification.summary,
    };

    // ⚠️ COMPLETED 不是直接设置的，而是从 Verification 推导的。
    // 必须通过 deriveCompletionFromVerification 检查 Completion 不变量。
    const currentMission = await this.missions.get(missionId);
    if (!currentMission) {
      throw new Error(`MISSION_NOT_FOUND:${missionId}`);
    }

    // Phase F-1.1: EvidenceScopeValid 上下文
    // 防止跨 Mission/跨 Action 证据污染
    const actionId = action.receiptId ?? `action_${missionId}`;
    const completionContext: MissionCompletionContext = {
      missionId,
      correlationId: currentMission.correlationId,
      operationId: currentMission.operationId,
      actionId,
      actionStartedAt: action.startedAt,
      actionCompletedAt: action.completedAt,
    };

    // ⚠️ Phase F-1.1: isSuccess 函数从 evidence 推导验证结论。
    // 不依赖存储的 confirmed 字段，而是检查：
    //   1. Provider 返回的 verification.confirmed（基于 OBSERVED 页面文本判断）
    //   2. evidence 中有 DERIVED application.status=SUBMITTED
    const isSuccess = (ev: Evidence[]): boolean => {
      if (verification.confirmed !== true) return false;
      const hasDerivedSubmitted = ev.some(
        (e) =>
          e.authority === "DERIVED" &&
          e.claimKey === "application.status" &&
          e.value === "SUBMITTED",
      );
      return hasDerivedSubmitted;
    };

    const completedMission = deriveCompletionFromVerification(
      currentMission,
      missionVerification,
      verification.evidence,
      completionContext,
      isSuccess,
    );

    if (completedMission.state !== "COMPLETED") {
      // 不满足 Completion 不变量，不能进入 COMPLETED
      // 这通常意味着 verification evidence 不是 OBSERVED authority
      await this.failMission(
        missionId,
        "COMPLETION_INVARIANT_VIOLATION",
        "POLICY",
        "Verification passed but completion invariants not satisfied (likely non-OBSERVED evidence)",
      );

      return {
        missionId,
        state: "FAILED" as MissionState,
        verification: verification.evidence,
        failure: {
          code: "COMPLETION_INVARIANT_VIOLATION",
          category: "POLICY",
          message:
            "Completion invariant violation: verification evidence must be OBSERVED authority",
          recoverable: false,
          retryable: false,
        },
      };
    }

    // 通过不变量检查，写入 verification 并设置 COMPLETED
    await this.missions.update(missionId, {
      state: "COMPLETED",
      verification: missionVerification,
      pendingApproval: undefined,
    });

    return {
      missionId,
      state: "COMPLETED" as MissionState,
      verification: verification.evidence,
      verificationSummary: verification.summary,
    };
  }

  // ============================================================
  // Internal helpers
  // ============================================================

  private async requireMission(
    id: string,
  ): Promise<MissionRecord> {
    const mission = await this.missions.get(id);
    if (!mission) {
      throw new Error(`MISSION_NOT_FOUND:${id}`);
    }
    return mission;
  }

  private async transition(
    missionId: string,
    state: MissionState,
  ): Promise<MissionRecord> {
    return this.missions.update(
      missionId,
      { state },
    );
  }

  private async failMission(
    missionId: string,
    code: string,
    category:
      | "VALIDATION"
      | "POLICY"
      | "NETWORK"
      | "PROVIDER"
      | "AUTH"
      | "TIMEOUT"
      | "CONFLICT"
      | "UNKNOWN",
    message: string,
  ): Promise<void> {
    await this.missions.update(
      missionId,
      {
        state: "FAILED",
        failure: {
          code,
          category,
          message,
          recoverable: false,
          retryable: false,
        },
      },
    );
  }
}
