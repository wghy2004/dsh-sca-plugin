/**
 * Event Sourced Mission Repository
 *
 * ⚠️ Phase F 核心：Mission 状态不是"写进去"的，而是"投影出来"的。
 *
 * 正确结构：
 *   Command → Mission Aggregate / Command Handler
 *     → Domain Event → Event Store → Projection → MissionRecord
 *
 * 错误结构（已废弃）：
 *   MissionRecord → update() → append event（先改状态，再记录事件）
 *
 * 本 Repository 实现：
 *   - create(): 发出 MissionCreated 事件
 *   - update(): 根据 patch 内容发出对应的 domain event，然后从事件流重新投影
 *   - get(): 从 Event Store 读取事件链，投影出 MissionRecord
 *   - checkpoint(): 发出 MissionCheckpointed 事件
 *
 * Domain Events 使用 SCA 的 "narrative" 类型写入 Event Store，
 * chainId 格式为 dsh_mission_{missionId}，与 SCA 的 traversal/observation 事件隔离。
 *
 * Mission 是"为什么/哪一次行动"，SCA Event 是"实际发生了什么"。
 * 两者通过 missionId / correlationId 关联，不混淆。
 */

import type {
  MissionRecord,
  MissionKind,
  MissionState,
  FailureState,
  ApprovalRequest,
  MissionAction,
  MissionVerification,
} from "../contract/types";
import { canTransition } from "../contract/mission";
import type { MissionRepository } from "../contract/mission";
import {
  assertVerificationBoundary,
  missionChainId,
  type VerificationCapturedEvent,
} from "../contract/mission-events";
import { projectMissionEvents } from "../contract/mission-projection";
import { commitSovereigntyTransaction, getDb } from "@sca/service-worker/db";
import type { SovereigntyEvent } from "@sca/shared/types";

function generateMissionId(): string {
  return `mission_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================
// Domain Event Payloads
// ============================================================

interface MissionCreatedPayload {
  note: "MISSION_CREATED";
  missionId: string;
  kind: MissionKind;
  input: unknown;
  correlationId: string;
  operationId: string;
  createdAt: number;
}

interface MissionStateChangedPayload {
  note: "MISSION_STATE_CHANGED";
  missionId: string;
  fromState: MissionState;
  toState: MissionState;
  reason?: string;
  changedAt: number;
}

interface MissionCheckpointedPayload {
  note: "MISSION_CHECKPOINTED";
  missionId: string;
  checkpoint: unknown;
  changedAt: number;
}

interface ApprovalRequestedPayload {
  note: "APPROVAL_REQUESTED";
  missionId: string;
  approval: ApprovalRequest;
  changedAt: number;
}

interface ApprovalResolvedPayload {
  note: "APPROVAL_GRANTED" | "APPROVAL_DENIED";
  missionId: string;
  reason?: string;
  changedAt: number;
}

interface ActionUpdatedPayload {
  note: "MISSION_ACTION_UPDATED";
  missionId: string;
  action: MissionAction;
  changedAt: number;
}

interface VerificationCapturedPayload {
  note: "MISSION_VERIFICATION_CAPTURED";
  missionId: string;
  verification: MissionVerification;
  changedAt: number;
}

interface MissionFailedPayload {
  note: "MISSION_FAILED";
  missionId: string;
  failure: FailureState;
  changedAt: number;
}

type MissionDomainEventPayload =
  | MissionCreatedPayload
  | MissionStateChangedPayload
  | MissionCheckpointedPayload
  | ApprovalRequestedPayload
  | ApprovalResolvedPayload
  | ActionUpdatedPayload
  | VerificationCapturedPayload
  | MissionFailedPayload;

// ============================================================
// Event Sourced Repository
// ============================================================

export class SCAMissionRepository implements MissionRepository {
  async create(
    kind: MissionKind,
    input: unknown,
    correlationId: string,
    operationId: string,
  ): Promise<MissionRecord> {
    const missionId = generateMissionId();
    const now = Date.now();
    const chainId = missionChainId(missionId);

    const payload: MissionCreatedPayload = {
      note: "MISSION_CREATED",
      missionId,
      kind,
      input,
      correlationId,
      operationId,
      createdAt: now,
    };

    await commitSovereigntyTransaction(
      { ...payload, chainId },
      "narrative",
      "service_worker",
    );

    const record: MissionRecord = {
      id: missionId,
      kind,
      state: "CREATED",
      createdAt: now,
      updatedAt: now,
      input,
      correlationId,
      operationId,
    };

    return record;
  }

  async get(id: string): Promise<MissionRecord | null> {
    const events = await this.getMissionEvents(id);
    if (events.length === 0) return null;
    return this.projectEvents(events);
  }

  async update(
    id: string,
    patch: Partial<Omit<MissionRecord, "id">>,
  ): Promise<MissionRecord> {
    const current = await this.get(id);
    if (!current) {
      throw new Error(`MISSION_NOT_FOUND:${id}`);
    }

    const chainId = missionChainId(id);
    const now = Date.now();

    // 1. 如果 state 变化，发出 MissionStateChanged 事件
    if (patch.state && patch.state !== current.state) {
      if (!canTransition(current.state, patch.state)) {
        throw new Error(
          `INVALID_MISSION_TRANSITION:${current.state}->${patch.state}`,
        );
      }

      const statePayload: MissionStateChangedPayload = {
        note: "MISSION_STATE_CHANGED",
        missionId: id,
        fromState: current.state,
        toState: patch.state,
        changedAt: now,
      };

      await commitSovereigntyTransaction(
        { ...statePayload, chainId },
        "narrative",
        "service_worker",
      );
    }

    // 2. 如果 checkpoint 变化，发出 MissionCheckpointed 事件
    if (patch.checkpoint !== undefined) {
      const checkpointPayload: MissionCheckpointedPayload = {
        note: "MISSION_CHECKPOINTED",
        missionId: id,
        checkpoint: patch.checkpoint,
        changedAt: now,
      };

      await commitSovereigntyTransaction(
        { ...checkpointPayload, chainId },
        "narrative",
        "service_worker",
      );
    }

    // 3. 如果 pendingApproval 变化，发出 ApprovalRequested 事件
    if (patch.pendingApproval) {
      const approvalPayload: ApprovalRequestedPayload = {
        note: "APPROVAL_REQUESTED",
        missionId: id,
        approval: patch.pendingApproval,
        changedAt: now,
      };

      await commitSovereigntyTransaction(
        { ...approvalPayload, chainId },
        "narrative",
        "service_worker",
      );
    }

    // 4. 如果 pendingApproval 被清除（批准或拒绝后），发出 ApprovalResolved 事件
    if (
      patch.pendingApproval === undefined &&
      current.pendingApproval !== undefined
    ) {
      const resolvedPayload: ApprovalResolvedPayload = {
        note: patch.state === "CANCELLED" ? "APPROVAL_DENIED" : "APPROVAL_GRANTED",
        missionId: id,
        changedAt: now,
      };

      await commitSovereigntyTransaction(
        { ...resolvedPayload, chainId },
        "narrative",
        "service_worker",
      );
    }

    // 5. 如果 action 变化，发出 ActionUpdated 事件
    if (patch.action) {
      const actionPayload: ActionUpdatedPayload = {
        note: "MISSION_ACTION_UPDATED",
        missionId: id,
        action: patch.action,
        changedAt: now,
      };

      await commitSovereigntyTransaction(
        { ...actionPayload, chainId },
        "narrative",
        "service_worker",
      );
    }

    // 6. 如果 verification 变化，发出 VerificationCaptured 事件
    if (patch.verification) {
      // ⚠️ Phase F-1: VerificationCaptured 边界断言
      // 确保不包含 authority 字段，只引用 evidenceIds
      const verificationEvent: VerificationCapturedEvent = {
        type: "VERIFICATION_CAPTURED",
        missionId: id,
        verification: patch.verification,
        changedAt: now,
      };
      assertVerificationBoundary(verificationEvent);

      const verificationPayload = {
        note: "MISSION_VERIFICATION_CAPTURED",
        missionId: id,
        verification: patch.verification,
        changedAt: now,
      };

      await commitSovereigntyTransaction(
        { ...verificationPayload, chainId },
        "narrative",
        "service_worker",
      );
    }

    // 7. 如果 failure 变化，发出 MissionFailed 事件
    if (patch.failure) {
      const failurePayload: MissionFailedPayload = {
        note: "MISSION_FAILED",
        missionId: id,
        failure: patch.failure,
        changedAt: now,
      };

      await commitSovereigntyTransaction(
        { ...failurePayload, chainId },
        "narrative",
        "service_worker",
      );
    }

    // 8. 从事件流重新投影（事件才是事实，MissionRecord 是投影）
    return this.get(id);
  }

  async checkpoint(
    id: string,
    checkpoint: unknown,
  ): Promise<MissionRecord> {
    return this.update(id, { checkpoint });
  }

  // ============================================================
  // Internal: Event Store 读取
  // ============================================================

  private async getMissionEvents(
    missionId: string,
  ): Promise<SovereigntyEvent[]> {
    const db = await getDb();
    const tx = db.transaction("events", "readonly");
    const events = await tx.store.index
      .by_chain()
      .getAll(missionChainId(missionId));
    await tx.done;
    return events.sort((a, b) => a.ts - b.ts);
  }

  // ============================================================
  // Internal: Projection
  //
  // MissionRecord 完全从事件流推导。
  // 不存在"直接修改状态"的路径。
  // ============================================================

  private projectEvents(events: SovereigntyEvent[]): MissionRecord {
    let record: MissionRecord | null = null;

    for (const event of events) {
      const payload = event.payload as MissionDomainEventPayload;

      switch (payload.note) {
        case "MISSION_CREATED":
          record = {
            id: payload.missionId,
            kind: payload.kind,
            state: "CREATED",
            createdAt: payload.createdAt,
            updatedAt: payload.createdAt,
            input: payload.input,
            correlationId: payload.correlationId,
            operationId: payload.operationId,
          };
          break;

        case "MISSION_STATE_CHANGED":
          if (record) {
            record.state = payload.toState;
            record.updatedAt = payload.changedAt;
          }
          break;

        case "MISSION_CHECKPOINTED":
          if (record) {
            record.checkpoint = payload.checkpoint;
            record.updatedAt = payload.changedAt;
          }
          break;

        case "APPROVAL_REQUESTED":
          if (record) {
            record.pendingApproval = payload.approval;
            record.updatedAt = payload.changedAt;
          }
          break;

        case "APPROVAL_GRANTED":
        case "APPROVAL_DENIED":
          if (record) {
            record.pendingApproval = undefined;
            record.updatedAt = payload.changedAt;
          }
          break;

        case "MISSION_ACTION_UPDATED":
          if (record) {
            record.action = payload.action;
            record.updatedAt = payload.changedAt;
          }
          break;

        case "MISSION_VERIFICATION_CAPTURED":
          if (record) {
            record.verification = payload.verification;
            record.updatedAt = payload.changedAt;
          }
          break;

        case "MISSION_FAILED":
          if (record) {
            record.failure = payload.failure;
            record.updatedAt = payload.changedAt;
          }
          break;
      }
    }

    if (!record) {
      throw new Error("MISSION_PROJECTION_FAILED: no MISSION_CREATED event found");
    }

    return record;
  }
}
