import type {
  Evidence,
  EvidenceSource,
} from "./types";

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * EvidenceFactory
 *
 * 这是插件内部的统一 Evidence 构造入口。
 *
 * ⚠️ Authority 边界（Phase A 修正）：
 *
 *   本工厂只允许产生 INFERRED / DERIVED / RETRACTED。
 *   OBSERVED 必须由 SCA Runtime 的 ProvenanceVerifier 产生，
 *   通过 ExistingSCARuntime Adapter 注入，Plugin 内部代码无权伪造。
 *
 *   这是 Evidence Authority Gate 的硬约束：
 *   SCA Observation → MessageStore/Raw Evidence → ProvenanceVerifier → OBSERVED → DSH Plugin
 *
 *   如果 Plugin 需要"观察到的事实"，必须从 Runtime 返回的 Evidence[] 中消费，
 *   不能自己构造 authority="OBSERVED" 的对象。
 */
export class EvidenceFactory {
  /**
   * 模型推理产生的证据。可信度由 confidence 表达，不具备现实权威性。
   */
  inferred<T>(
    claimKey: string,
    value: T,
    options?: {
      confidence?: number;
      source?: EvidenceSource;
    },
  ): Evidence<T> {
    return this.create(
      claimKey,
      value,
      "INFERRED",
      options?.source,
      options?.confidence,
    );
  }

  /**
   * 确定性计算产生的证据。例如匹配度评分、聚合统计。
   * 必须在 derivedFromEvidenceIds 中追溯到上游 OBSERVED。
   */
  derived<T>(
    claimKey: string,
    value: T,
    options?: {
      confidence?: number;
      source?: EvidenceSource;
    },
  ): Evidence<T> {
    return this.create(
      claimKey,
      value,
      "DERIVED",
      options?.source,
      options?.confidence,
    );
  }

  /**
   * 撤回已有证据。通常用于 OBSERVED 被证伪后的状态变更。
   */
  retract<T>(
    evidence: Evidence<T>,
    timestamp = Date.now(),
  ): Evidence<T> {
    return {
      ...evidence,
      authority: "RETRACTED",
      retractedAt: timestamp,
    };
  }

  private create<T>(
    claimKey: string,
    value: T,
    authority: "INFERRED" | "DERIVED",
    source?: EvidenceSource,
    confidence?: number,
  ): Evidence<T> {
    return {
      id: generateId("ev"),
      claimKey,
      value,
      authority,
      source,
      confidence,
      createdAt: Date.now(),
    };
  }
}
