import type {
  ActionReceipt,
  ApplyPreparation,
  ApplyRequest,
  Evidence,
  Job,
  JobInspectResult,
  JobSearchRequest,
  VerificationResult,
} from "../contract/types";

export interface SearchProvider {
  search(
    request: JobSearchRequest,
    signal?: AbortSignal,
  ): Promise<{
    jobs: Job[];
    evidence: Evidence[];
  }>;
}

export interface InspectionProvider {
  inspect(
    jobId: string,
    signal?: AbortSignal,
  ): Promise<JobInspectResult>;
}

/**
 * ApplicationProvider —— 三段式外部行动接口（Phase A 升级）
 *
 * 设计原则：
 *   prepare  → 评估可行性，不产生副作用
 *   execute  → 执行外部行动，返回回执（accepted !== 成功）
 *   verify   → 基于 OBSERVED Evidence 确认现实世界状态
 *
 * 不再使用单一 apply() 方法，因为"点击了提交"和"现实世界已成功"不是同一个事实。
 * 没有 verify 阶段的 OBSERVED 证据，不能进入 COMPLETED。
 */
export interface ApplicationProvider {
  prepare(
    request: ApplyRequest,
    signal?: AbortSignal,
  ): Promise<ApplyPreparation>;

  execute(
    missionId: string,
    approvalToken?: string,
    signal?: AbortSignal,
  ): Promise<ActionReceipt>;

  verify(
    missionId: string,
    signal?: AbortSignal,
  ): Promise<VerificationResult>;
}

/**
 * Capability Provider Aggregate
 *
 * SCA Core 通过这一层接入真正的浏览器、招聘平台、邮件等现实世界能力。
 */
export interface SCAProvider {
  readonly id: string;

  search: SearchProvider;
  inspection: InspectionProvider;
  application: ApplicationProvider;
}
