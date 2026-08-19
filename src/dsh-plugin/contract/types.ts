/**
 * SCA DSH Plugin Contract
 *
 * 设计原则：
 * - Model-facing API 只暴露语义对象
 * - 不暴露 Chrome TabId / DOM Selector / IndexedDB Key
 * - State / Evidence / Policy / Mission 均有明确权威归属
 *
 * Authority 边界（Phase A 修正）：
 *   OBSERVED  只能由 SCA Runtime / ProvenanceVerifier 产生，通过 Adapter 注入
 *   INFERRED  由 Model / Plugin 推理产生
 *   DERIVED   由确定性计算产生
 *   RETRACTED 不再被信任
 *
 * EvidenceFactory 不再提供 observed() —— 任何 Plugin 内部代码都不能伪造 OBSERVED。
 */

export type Authority =
  | "OBSERVED"
  | "INFERRED"
  | "DERIVED"
  | "RETRACTED";

export type MissionState =
  | "CREATED"
  | "PLANNING"
  | "DISCOVERING"
  | "COLLECTING"
  | "EVALUATING"
  | "AWAITING_APPROVAL"
  | "EXECUTING"
  | "VERIFYING"
  | "COMPLETED"
  | "PAUSED"
  | "FAILED"
  | "CANCELLED";

export type MissionKind =
  | "JOB_SEARCH"
  | "JOB_INSPECTION"
  | "JOB_APPLICATION";

export type PolicyEffect =
  | "ALLOW"
  | "DENY"
  | "APPROVAL_REQUIRED";

export type FailureCategory =
  | "VALIDATION"
  | "POLICY"
  | "NETWORK"
  | "PROVIDER"
  | "AUTH"
  | "TIMEOUT"
  | "CONFLICT"
  | "UNKNOWN";

export interface FailureState {
  code: string;
  category: FailureCategory;
  message: string;
  recoverable: boolean;
  retryable: boolean;
  nextAction?: string;
  details?: unknown;
}

export interface EvidenceSource {
  providerId: string;
  uri?: string;
  observedAt: number;
  locator?: string;
}

export interface Evidence<T = unknown> {
  id: string;
  claimKey: string;
  value: T;
  authority: Authority;

  /**
   * ⚠️ Phase F-1.1: Evidence 作用域关联。
   *
   * 时间范围 (createdAt >= actionStartedAt) 不足以证明证据属于本次 Action。
   * 必须通过 missionId + actionId 明确关联，防止跨 Mission/跨 Action 证据污染。
   *
   * 权威链：
   *   Evidence.missionId === Mission.id
   *   Evidence.actionId === Mission.action.id (if action exists)
   *   Evidence.correlationId === Mission.correlationId
   *
   * 缺少这些关联的 Evidence 不能用于 Completion 验证。
   */
  missionId?: string;
  actionId?: string;
  correlationId?: string;

  source?: EvidenceSource;

  /**
   * 对具体 Claim 的置信度（0-1）。
   * 注意：这不是 Authority 本身的 trust，Authority 是认识论分类。
   */
  confidence?: number;

  createdAt: number;
  retractedAt?: number;

  /**
   * ⚠️ P1-3 Fix: Provenance chain for DERIVED Evidence.
   *
   * DERIVED Evidence must trace back to upstream OBSERVED/DERIVED Evidence.
   * This forms a directed acyclic provenance graph:
   *   OBSERVED → DERIVED → DERIVED → ...
   *
   * For DERIVED authority, this field MUST be non-empty and reference
   * valid upstream Evidence IDs.
   *
   * Example:
   *   DERIVED application.status=SUBMITTED
   *     derivedFromEvidenceIds: ["obs_123_page_text"]  // OBSERVED page text
   */
  derivedFromEvidenceIds?: string[];
}

export interface CareerConstraint {
  location?: string;
  minimumSalary?: number;
  maximumSalary?: number;
  salaryCurrency?: string;
  blockedKeywords?: string[];
  blockedPlatforms?: string[];
  preferredPlatforms?: string[];
  remoteOnly?: boolean;
  minimumMatchScore?: number;
  directHireOnly?: boolean;
}

export interface CareerState {
  version: number;
  identityAnchor?: string;
  targetRoles: string[];
  hardSkills: string[];
  softSkills: string[];
  achievements: string[];
  constraints: CareerConstraint;
  source: "SCA";
  updatedAt: number;
}

export interface Job {
  id: string;
  title: string;
  company?: string;
  location?: string;
  salary?: string;
  platform?: string;
  url: string;

  /**
   * 现实世界字段尽可能带证据。
   * 注意：字段本身 ≠ 事实，每个可验证字段都应关联 OBSERVED Evidence。
   */
  evidence: Evidence[];

  /**
   * 计算结果不能冒充 Observation。
   */
  matchScore?: number;
}

export interface JobMatch {
  jobId: string;
  score: number;
  strengths: string[];
  gaps: string[];
  risks: string[];
  derivedFromEvidenceIds: string[];
}

export interface JobSearchRequest {
  query: string;
  constraints?: CareerConstraint;
  limit?: number;
}

export interface JobSearchResult {
  missionId: string;
  state: MissionState;
  results: Job[];
  total: number;
  hasMore: boolean;
  nextAction?: string;
}

export interface JobInspectRequest {
  jobId: string;
}

export interface JobInspectResult {
  missionId: string;
  job: Job;
  match?: JobMatch;
}

export interface ApplyRequest {
  jobId: string;
  resumeId?: string;
  message?: string;
  approvalToken?: string;
}

export interface ApplicationResult {
  missionId: string;
  jobId: string;
  state: MissionState;

  /**
   * Never return "success=true" without evidence.
   * COMPLETED 必须伴随 OBSERVED 级别的 verification evidence。
   */
  verification?: Evidence[];
  failure?: FailureState;
}

// ============================================================
// Approval / Action / Verification —— Mission 执行实例字段
// ============================================================

export interface ApprovalRequest {
  missionId: string;
  reason: string;
  requestedAt: number;
  expiresAt?: number;
}

export interface ApprovalDecision {
  approved: boolean;
  approvalToken?: string;
  reason?: string;
  decidedAt: number;
}

/**
 * 一次现实世界行动的执行记录。
 * 区分"点击了提交"和"现实世界已成功"。
 */
export interface MissionAction {
  type: string;
  startedAt?: number;
  completedAt?: number;
  receiptId?: string;
  /** Provider 返回的原始执行回执，不向 Model 暴露实现细节。 */
  receipt?: unknown;
}

/**
 * 验证结果。必须基于 OBSERVED Evidence，不能基于 Provider 的 accepted:true。
 *
 * ⚠️ Phase F-1.1: 不存储 confirmed 字段。
 * confirmed 本质上是从 Evidence 推导的 Projection/Derived State，
 * 不应该成为 Event Store 中的历史事实。
 *
 * Completion Gate 会根据 evidenceIds 对应的实际 Evidence 推导验证结论。
 */
export interface MissionVerification {
  evidenceIds: string[];
  verifiedAt: number;
  summary?: string;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  reason: string;
  approval?: ApprovalRequest;
}

// ============================================================
// Application Provider 三段式接口（Phase A 升级）
// ============================================================

/**
 * prepare 阶段的输出：Provider 评估投递可行性，生成执行计划。
 * 不产生外部副作用。
 */
export interface ApplyPreparation {
  missionId: string;
  jobId: string;
  ready: boolean;
  /** 缺失的前置条件，如未登录、简历未上传。 */
  blockers?: string[];
  /** Provider 内部的执行计划标识，后续 execute 时使用。 */
  planId?: string;
  estimatedDurationMs?: number;
}

/**
 * execute 阶段的输出：Provider 执行了外部行动，返回执行回执。
 * 注意：accepted !== 现实世界成功，必须经过 verify。
 */
export interface ActionReceipt {
  missionId: string;
  accepted: boolean;
  receiptId?: string;
  /** 执行过程中捕获的原始观察，用于后续 verify。 */
  evidence: Evidence[];
  failure?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

/**
 * verify 阶段的输出：基于 OBSERVED Evidence 确认现实世界状态。
 */
export interface VerificationResult {
  missionId: string;
  confirmed: boolean;
  /** 必须是 OBSERVED 级别的证据。 */
  evidence: Evidence[];
  summary?: string;
  failure?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

// ============================================================
// MissionRecord —— 从"状态机"升级为"执行实例"
// ============================================================

/**
 * ⚠️ P0-4 Fix: Mission / Job / Action Identity Separation.
 *
 * Mission = 用户发起的一次任务（意图身份）
 * Job = 现实世界中的一个实体（现实实体身份）
 * Action = 针对这个实体的一次行为（执行身份）
 *
 * 三者应该是：
 *   Mission
 *      └── target → Job
 *                    └── Action
 *
 * 而不是 MissionId == JobId（把意图身份和现实实体身份混在一起）。
 */
export interface MissionTarget {
  entityType: "JOB";
  entityId: string; // jobId
}

export interface MissionRecord {
  id: string;
  kind: MissionKind;
  state: MissionState;
  createdAt: number;
  updatedAt: number;

  input: unknown;

  /**
   * ⚠️ P0-4 Fix: Mission 的目标实体引用。
   * 区分"意图身份"（Mission.id）和"现实实体身份"（target.entityId）。
   */
  target?: MissionTarget;

  checkpoint?: unknown;

  /** 待审批信息：处于 AWAITING_APPROVAL 时填充。 */
  pendingApproval?: ApprovalRequest;

  /** 外部行动执行记录。 */
  action?: MissionAction;

  /** 验证结果：必须基于 OBSERVED Evidence。 */
  verification?: MissionVerification;

  failure?: FailureState;

  correlationId: string;
  operationId: string;
}

export interface MissionStatus {
  mission: MissionRecord;
}
