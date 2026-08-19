/**
 * Mission Domain Event Schema
 *
 * ⚠️ Phase F-1: Mission Event Schema 语义边界定死。
 *
 * Mission 不"存 State"，Mission 是"投影 State"。
 * 这些 Domain Event 写入 SCA Event Store（type=narrative, chainId=dsh_mission_{id}），
 * MissionRecord 完全由这些事件投影产生。
 *
 * 语义分层：
 *   Mission     → 为什么要做这个事情？（业务意图）
 *   Execution   → 现实世界做了什么？（SCA 执行）
 *   Evidence    → 现实世界发生了什么可验证事实？（Observation）
 *
 * 三者通过 correlationId / operationId / evidenceIds 关联，不混成一个 Aggregate。
 */

import type {
  ApprovalRequest,
  FailureState,
  MissionAction,
  MissionKind,
  MissionState,
  MissionVerification,
} from "./types";

// ============================================================
// Event Type 枚举
// ============================================================

export type MissionEventType =
  | "MISSION_CREATED"
  | "MISSION_STATE_CHANGED"
  | "MISSION_CHECKPOINTED"
  | "APPROVAL_REQUESTED"
  | "APPROVAL_GRANTED"
  | "APPROVAL_DENIED"
  | "ACTION_UPDATED"
  | "VERIFICATION_CAPTURED"
  | "MISSION_FAILED";

// ============================================================
// Event Payloads —— 每个事件的语义边界
// ============================================================

/**
 * MissionCreated
 *
 * 语义：用户/DSH 请求产生了一次 Mission。
 * 只表达"意图存在"，不表达任何执行状态。
 */
export interface MissionCreatedEvent {
  type: "MISSION_CREATED";
  missionId: string;
  kind: MissionKind;
  input: unknown;
  correlationId: string;
  operationId: string;
  createdAt: number;
}

/**
 * MissionStateChanged
 *
 * 语义：Mission projection 的生命周期变化。
 * 只表达"状态机迁移"，不表达"为什么迁移"（原因在其他事件中）。
 *
 * 合法迁移由 canTransition() 校验，非法迁移不会产生此事件。
 */
export interface MissionStateChangedEvent {
  type: "MISSION_STATE_CHANGED";
  missionId: string;
  fromState: MissionState;
  toState: MissionState;
  reason?: string;
  changedAt: number;
}

/**
 * MissionCheckpointed
 *
 * 语义：执行过程中的检查点数据。
 * 用于恢复中断的 Mission，不影响状态机。
 */
export interface MissionCheckpointedEvent {
  type: "MISSION_CHECKPOINTED";
  missionId: string;
  checkpoint: unknown;
  changedAt: number;
}

/**
 * ApprovalRequested
 *
 * 语义：Policy Gate 判断此次行动需要外部批准。
 * 只表达"请求了批准"，不表达"批准了"。
 */
export interface ApprovalRequestedEvent {
  type: "APPROVAL_REQUESTED";
  missionId: string;
  approval: ApprovalRequest;
  changedAt: number;
}

/**
 * ApprovalGranted
 *
 * 语义：Policy Gate 获得了合法批准。
 * 批准后 Mission 可以从 AWAITING_APPROVAL 迁移到 EXECUTING。
 */
export interface ApprovalGrantedEvent {
  type: "APPROVAL_GRANTED";
  missionId: string;
  approvalToken?: string;
  reason?: string;
  changedAt: number;
}

/**
 * ApprovalDenied
 *
 * 语义：批准被拒绝。
 * 拒绝后 Mission 进入 CANCELLED。
 */
export interface ApprovalDeniedEvent {
  type: "APPROVAL_DENIED";
  missionId: string;
  reason?: string;
  changedAt: number;
}

/**
 * ActionUpdated
 *
 * 语义：SCA 执行层发生了行动状态变化。
 * 只表达"执行层状态"，不表达"现实世界结果"（结果在 Verification 中）。
 *
 * 注意：action.receipt 是 Provider 返回的原始执行回执，
 * 不能作为 Verification 依据（accepted !== 成功）。
 */
export interface ActionUpdatedEvent {
  type: "ACTION_UPDATED";
  missionId: string;
  action: MissionAction;
  changedAt: number;
}

/**
 * VerificationCaptured
 *
 * 语义：已经获得此次 action 的验证结果。
 *
 * ⚠️ 关键边界：
 *   此事件只引用 evidenceIds，不包含 authority 字段。
 *   真正的 Evidence Authority 在 Evidence/Event 链上（OBSERVED / DERIVED）。
 *
 *   verification.confirmed 是 DERIVED 结论（从 OBSERVED 推导），
 *   不是 OBSERVED 事实本身。
 *
 *   不存在 "authority: OBSERVED" 在此事件中。
 */
export interface VerificationCapturedEvent {
  type: "VERIFICATION_CAPTURED";
  missionId: string;
  verification: MissionVerification;
  changedAt: number;
}

/**
 * MissionFailed
 *
 * 语义：Mission 因不可恢复的原因失败。
 * failure 包含失败分类和恢复建议。
 */
export interface MissionFailedEvent {
  type: "MISSION_FAILED";
  missionId: string;
  failure: FailureState;
  changedAt: number;
}

// ============================================================
// Union Type
// ============================================================

export type MissionDomainEvent =
  | MissionCreatedEvent
  | MissionStateChangedEvent
  | MissionCheckpointedEvent
  | ApprovalRequestedEvent
  | ApprovalGrantedEvent
  | ApprovalDeniedEvent
  | ActionUpdatedEvent
  | VerificationCapturedEvent
  | MissionFailedEvent;

// ============================================================
// Event → SCA Narrative Payload 映射
//
// SCA Event Store 的 SovereigntyEvent.type = "narrative"，
// payload.note 字段用于区分 Mission Domain Event 类型。
// ============================================================

export const MISSION_EVENT_NOTE_MAP: Record<MissionEventType, string> = {
  MISSION_CREATED: "MISSION_CREATED",
  MISSION_STATE_CHANGED: "MISSION_STATE_CHANGED",
  MISSION_CHECKPOINTED: "MISSION_CHECKPOINTED",
  APPROVAL_REQUESTED: "APPROVAL_REQUESTED",
  APPROVAL_GRANTED: "APPROVAL_GRANTED",
  APPROVAL_DENIED: "APPROVAL_DENIED",
  ACTION_UPDATED: "MISSION_ACTION_UPDATED",
  VERIFICATION_CAPTURED: "MISSION_VERIFICATION_CAPTURED",
  MISSION_FAILED: "MISSION_FAILED",
};

export function missionChainId(missionId: string): string {
  return `dsh_mission_${missionId}`;
}

// ============================================================
// 语义边界断言
// ============================================================

/**
 * 验证 VerificationCaptured 事件的语义边界。
 *
 * ⚠️ Phase F-1.1:
 *   1. 不能包含 authority 字段（Evidence Authority 在 Evidence/Event 链上）
 *   2. 不能包含 confirmed 字段（confirmed 是 Derived State，不是历史事实）
 *   3. evidenceIds 必须非空
 */
export function assertVerificationBoundary(
  event: VerificationCapturedEvent,
): void {
  const v = event.verification;

  if (v && typeof v === "object" && "authority" in v) {
    throw new Error(
      "VERIFICATION_BOUNDARY_VIOLATION: VerificationCaptured must not contain authority field. " +
        "Evidence authority lives on the Evidence/Event chain, referenced by evidenceIds.",
    );
  }

  if (v && typeof v === "object" && "confirmed" in v) {
    throw new Error(
      "VERIFICATION_BOUNDARY_VIOLATION: VerificationCaptured must not contain confirmed field. " +
        "confirmed is a Derived State projected from Evidence, not a historical fact to store.",
    );
  }

  if (!v.evidenceIds || v.evidenceIds.length === 0) {
    throw new Error(
      "VERIFICATION_BOUNDARY_VIOLATION: VerificationCaptured must contain non-empty evidenceIds.",
    );
  }
}
