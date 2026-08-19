/**
 * Mission Projection —— 纯函数层
 *
 * ⚠️ Phase F: Mission 不"存 State"，Mission 是"投影 State"。
 *
 * 这个模块包含从 Mission Domain Event 流投影出 MissionRecord 的纯函数。
 * 不依赖任何运行时模块（chrome/IDB/fetch），可以在任何环境中测试。
 *
 * 投影规则：
 *   Event Store
 *     │
 *     ├── MISSION_CREATED          → 初始化 MissionRecord
 *     ├── MISSION_STATE_CHANGED    → 更新 state
 *     ├── MISSION_CHECKPOINTED     → 更新 checkpoint
 *     ├── APPROVAL_REQUESTED       → 更新 pendingApproval
 *     ├── APPROVAL_GRANTED         → 清除 pendingApproval
 *     ├── APPROVAL_DENIED          → 清除 pendingApproval + failure
 *     ├── ACTION_UPDATED           → 更新 action
 *     ├── VERIFICATION_CAPTURED    → 更新 verification
 *     └── MISSION_FAILED           → 更新 failure + state=FAILED
 *     │
 *     ▼
 *   MissionRecord（投影结果）
 *
 * 核心不变量：
 *   删除 MissionRecord → 重新读取 Event Store → replay → 得到完全相同的 MissionRecord
 */

import type {
  MissionRecord,
  MissionState,
} from "./types";
import type {
  MissionDomainEvent,
  MissionCreatedEvent,
  MissionStateChangedEvent,
  MissionCheckpointedEvent,
  ApprovalRequestedEvent,
  ApprovalGrantedEvent,
  ApprovalDeniedEvent,
  ActionUpdatedEvent,
  VerificationCapturedEvent,
  MissionFailedEvent,
} from "./mission-events";

/**
 * 从 Mission Domain Event 流投影出 MissionRecord。
 *
 * 这是纯函数：相同的事件输入总是产生相同的投影输出。
 * 不依赖外部状态，可以用于 Replay 测试。
 *
 * @param events 按时间排序的 Mission Domain Event 列表
 * @returns 投影后的 MissionRecord，如果没有 MISSION_CREATED 事件则返回 null
 */
export function projectMissionEvents(
  events: MissionDomainEvent[],
): MissionRecord | null {
  if (events.length === 0) return null;

  // 找到 MISSION_CREATED 事件（必须是第一个事件）
  const createdEvent = events.find(
    (e): e is MissionCreatedEvent => e.type === "MISSION_CREATED",
  );

  if (!createdEvent) {
    return null;
  }

  // 初始化 MissionRecord
  let mission: MissionRecord = {
    id: createdEvent.missionId,
    kind: createdEvent.kind,
    state: "CREATED",
    createdAt: createdEvent.createdAt,
    updatedAt: createdEvent.createdAt,
    input: createdEvent.input,
    correlationId: createdEvent.correlationId,
    operationId: createdEvent.operationId,
  };

  // 按顺序应用后续事件
  for (const event of events) {
    if (event.type === "MISSION_CREATED") continue; // 已处理

    mission = applyEvent(mission, event);
  }

  return mission;
}

/**
 * 应用单个事件到 MissionRecord。
 */
function applyEvent(
  mission: MissionRecord,
  event: MissionDomainEvent,
): MissionRecord {
  switch (event.type) {
    case "MISSION_STATE_CHANGED":
      return applyStateChanged(mission, event);

    case "MISSION_CHECKPOINTED":
      return applyCheckpointed(mission, event);

    case "APPROVAL_REQUESTED":
      return applyApprovalRequested(mission, event);

    case "APPROVAL_GRANTED":
      return applyApprovalGranted(mission, event);

    case "APPROVAL_DENIED":
      return applyApprovalDenied(mission, event);

    case "ACTION_UPDATED":
      return applyActionUpdated(mission, event);

    case "VERIFICATION_CAPTURED":
      return applyVerificationCaptured(mission, event);

    case "MISSION_FAILED":
      return applyFailed(mission, event);

    default:
      return mission;
  }
}

function applyStateChanged(
  mission: MissionRecord,
  event: MissionStateChangedEvent,
): MissionRecord {
  return {
    ...mission,
    state: event.toState,
    updatedAt: event.changedAt,
  };
}

function applyCheckpointed(
  mission: MissionRecord,
  event: MissionCheckpointedEvent,
): MissionRecord {
  return {
    ...mission,
    checkpoint: event.checkpoint,
    updatedAt: event.changedAt,
  };
}

function applyApprovalRequested(
  mission: MissionRecord,
  event: ApprovalRequestedEvent,
): MissionRecord {
  return {
    ...mission,
    state: "AWAITING_APPROVAL",
    pendingApproval: event.approval,
    updatedAt: event.changedAt,
  };
}

function applyApprovalGranted(
  mission: MissionRecord,
  event: ApprovalGrantedEvent,
): MissionRecord {
  return {
    ...mission,
    pendingApproval: undefined,
    updatedAt: event.changedAt,
  };
}

function applyApprovalDenied(
  mission: MissionRecord,
  event: ApprovalDeniedEvent,
): MissionRecord {
  return {
    ...mission,
    state: "CANCELLED",
    pendingApproval: undefined,
    failure: event.reason
      ? {
          code: "APPROVAL_DENIED",
          category: "POLICY",
          message: event.reason,
          recoverable: false,
          retryable: false,
        }
      : undefined,
    updatedAt: event.changedAt,
  };
}

function applyActionUpdated(
  mission: MissionRecord,
  event: ActionUpdatedEvent,
): MissionRecord {
  return {
    ...mission,
    action: event.action,
    updatedAt: event.changedAt,
  };
}

function applyVerificationCaptured(
  mission: MissionRecord,
  event: VerificationCapturedEvent,
): MissionRecord {
  return {
    ...mission,
    verification: event.verification,
    updatedAt: event.changedAt,
  };
}

function applyFailed(
  mission: MissionRecord,
  event: MissionFailedEvent,
): MissionRecord {
  return {
    ...mission,
    state: "FAILED",
    failure: event.failure,
    updatedAt: event.changedAt,
  };
}

// ============================================================
// Replay 测试辅助：构造事件场景
// ============================================================

export interface ReplayTestScenario {
  name: string;
  description: string;
  events: MissionDomainEvent[];
  expectedState: MissionState;
  expectedFields?: Partial<MissionRecord>;
}

/**
 * 构造 Replay 测试场景。
 * 用于验证 Mission 可以从 Event Store 完整重建。
 */
export function buildReplayScenarios(): ReplayTestScenario[] {
  const baseCreated = (
    id: string,
    kind: MissionRecord["kind"] = "JOB_SEARCH",
  ): MissionCreatedEvent => ({
    type: "MISSION_CREATED",
    missionId: id,
    kind,
    input: { query: "Java 后端" },
    correlationId: `corr-${id}`,
    operationId: `op-${id}`,
    createdAt: 1000,
  });

  const stateChange = (
    id: string,
    from: MissionState,
    to: MissionState,
    ts: number,
  ): MissionStateChangedEvent => ({
    type: "MISSION_STATE_CHANGED",
    missionId: id,
    fromState: from,
    toState: to,
    changedAt: ts,
  });

  return [
    {
      name: "空事件流",
      description: "没有任何事件，投影结果为 null",
      events: [],
      expectedState: "CREATED" as MissionState, // 不会用到，因为返回 null
      expectedFields: undefined,
    },
    {
      name: "只有 MISSION_CREATED",
      description: "只有创建事件，状态为 CREATED",
      events: [baseCreated("m-1")],
      expectedState: "CREATED",
      expectedFields: {
        id: "m-1",
        kind: "JOB_SEARCH",
        correlationId: "corr-m-1",
      },
    },
    {
      name: "Search 完整流程",
      description: "CREATED → PLANNING → DISCOVERING → COLLECTING → EVALUATING → COMPLETED",
      events: [
        baseCreated("m-2"),
        stateChange("m-2", "CREATED", "PLANNING", 1001),
        stateChange("m-2", "PLANNING", "DISCOVERING", 1002),
        stateChange("m-2", "DISCOVERING", "COLLECTING", 1003),
        stateChange("m-2", "COLLECTING", "EVALUATING", 1004),
        stateChange("m-2", "EVALUATING", "COMPLETED", 1005),
      ],
      expectedState: "COMPLETED",
      expectedFields: {
        id: "m-2",
        updatedAt: 1005,
      },
    },
    {
      name: "Apply 需要审批流程",
      description: "CREATED → PLANNING → AWAITING_APPROVAL（通过 APPROVAL_REQUESTED）",
      events: [
        baseCreated("m-3", "JOB_APPLICATION"),
        stateChange("m-3", "CREATED", "PLANNING", 1001),
        {
          type: "APPROVAL_REQUESTED",
          missionId: "m-3",
          approval: {
            missionId: "m-3",
            reason: "投递需要审批",
            requestedAt: 1002,
          },
          changedAt: 1002,
        } as ApprovalRequestedEvent,
      ],
      expectedState: "AWAITING_APPROVAL",
      expectedFields: {
        pendingApproval: {
          missionId: "m-3",
          reason: "投递需要审批",
          requestedAt: 1002,
        },
      },
    },
    {
      name: "Apply 审批被拒绝",
      description: "AWAITING_APPROVAL → APPROVAL_DENIED → CANCELLED",
      events: [
        baseCreated("m-4", "JOB_APPLICATION"),
        stateChange("m-4", "CREATED", "PLANNING", 1001),
        {
          type: "APPROVAL_REQUESTED",
          missionId: "m-4",
          approval: { missionId: "m-4", reason: "需要审批", requestedAt: 1002 },
          changedAt: 1002,
        } as ApprovalRequestedEvent,
        {
          type: "APPROVAL_DENIED",
          missionId: "m-4",
          reason: "用户拒绝",
          changedAt: 1003,
        } as ApprovalDeniedEvent,
      ],
      expectedState: "CANCELLED",
      expectedFields: {
        pendingApproval: undefined,
        failure: {
          code: "APPROVAL_DENIED",
          category: "POLICY",
          message: "用户拒绝",
          recoverable: false,
          retryable: false,
        },
      },
    },
    {
      name: "Apply 完整成功流程",
      description: "CREATED → EXECUTING → ActionUpdated → VERIFYING → VerificationCaptured → COMPLETED",
      events: [
        baseCreated("m-5", "JOB_APPLICATION"),
        stateChange("m-5", "CREATED", "EXECUTING", 1001),
        {
          type: "ACTION_UPDATED",
          missionId: "m-5",
          action: {
            type: "JOB_APPLICATION",
            startedAt: 1001,
            completedAt: 1005,
            receiptId: "receipt-1",
          },
          changedAt: 1005,
        } as ActionUpdatedEvent,
        stateChange("m-5", "EXECUTING", "VERIFYING", 1006),
        {
          type: "VERIFICATION_CAPTURED",
          missionId: "m-5",
          verification: {
            evidenceIds: ["ev-1", "ev-2"],
            verifiedAt: 1007,
            confirmed: true,
            summary: "投递成功",
          },
          changedAt: 1007,
        } as VerificationCapturedEvent,
        stateChange("m-5", "VERIFYING", "COMPLETED", 1008),
      ],
      expectedState: "COMPLETED",
      expectedFields: {
        action: {
          type: "JOB_APPLICATION",
          startedAt: 1001,
          completedAt: 1005,
          receiptId: "receipt-1",
        },
        verification: {
          evidenceIds: ["ev-1", "ev-2"],
          verifiedAt: 1007,
          confirmed: true,
          summary: "投递成功",
        },
      },
    },
    {
      name: "Mission 失败",
      description: "CREATED → PLANNING → MISSION_FAILED",
      events: [
        baseCreated("m-6"),
        stateChange("m-6", "CREATED", "PLANNING", 1001),
        {
          type: "MISSION_FAILED",
          missionId: "m-6",
          failure: {
            code: "NETWORK_ERROR",
            category: "NETWORK",
            message: "网络连接失败",
            recoverable: true,
            retryable: true,
          },
          changedAt: 1002,
        } as MissionFailedEvent,
      ],
      expectedState: "FAILED",
      expectedFields: {
        failure: {
          code: "NETWORK_ERROR",
          category: "NETWORK",
          message: "网络连接失败",
          recoverable: true,
          retryable: true,
        },
      },
    },
  ];
}
