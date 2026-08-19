import type {
  ActionReceipt,
  ApplyPreparation,
  ApplyRequest,
  CareerState,
  Evidence,
  Job,
  JobInspectResult,
  JobSearchRequest,
  VerificationResult,
} from "../contract/types";
import type {
  CareerStateProvider,
} from "../services/career-service";
import type {
  SCAProvider,
} from "../providers/types";

import {
  NullSCAProvider,
} from "../providers/sca-provider";

/**
 * SCA Runtime Adapter
 *
 * 这是整个 DSH Plugin 最重要的边界。
 *
 * DSH Plugin 不直接依赖：
 *
 * - chrome.*
 * - IndexedDB
 * - shadowTabExecutor
 * - SeedGenerator
 * - policy.ts
 * - WDL VM
 *
 * 这些能力全部通过 Adapter 注入。
 *
 * ⚠️ OBSERVED Authority 边界：
 *   ExistingSCARuntime 是唯一允许返回 authority="OBSERVED" Evidence 的来源。
 *   Plugin 内部的 EvidenceFactory 不再提供 observed() 方法。
 *   所有现实世界事实必须经由 SCA Observation → ProvenanceVerifier → Event Store 后，
 *   通过本 Adapter 以 OBSERVED Evidence 的形式注入。
 */

export interface ExistingSCARuntime {
  /**
   * 当前 SCA 职业画像 / Constitution 的读取入口。
   * SCA Profile = State Authority，DSH CareerState = Semantic Projection。
   */
  getCareerState(): Promise<CareerState>;

  /**
   * 搜索职位。
   *
   * 桥接到：SeedGenerator → Traversal → Observation → Matcher
   *
   * DSH 负责"我要什么"，SCA 负责"现实世界怎么找"。
   * DSH 不应该知道招聘网站的 URL、Selector、TabId。
   */
  searchJobs(
    request: JobSearchRequest,
    signal?: AbortSignal,
  ): Promise<{
    jobs: Job[];
    evidence: Evidence[];
  }>;

  /**
   * 检查职位详情。
   *
   * 桥接到现有 Observation Pipeline。
   * 字段本身 ≠ 事实，每个可验证字段必须关联 OBSERVED Evidence。
   */
  inspectJob(
    jobId: string,
    signal?: AbortSignal,
  ): Promise<JobInspectResult>;

  /**
   * 投递准备：评估可行性，不产生外部副作用。
   * 检查登录状态、简历完整性、平台限制等。
   */
  prepareApply(
    request: ApplyRequest,
    signal?: AbortSignal,
  ): Promise<ApplyPreparation>;

  /**
   * 执行投递：触发外部行动（WDL/Browser 操作）。
   * accepted !== 现实世界成功，必须经过 verifyApply。
   */
  executeApply(
    missionId: string,
    approvalToken?: string,
    signal?: AbortSignal,
  ): Promise<ActionReceipt>;

  /**
   * 验证投递：基于 OBSERVED Evidence 确认现实世界状态。
   * 例如读取"已投递"页面状态，经 ProvenanceVerifier 后返回 OBSERVED Evidence。
   */
  verifyApply(
    missionId: string,
    signal?: AbortSignal,
  ): Promise<VerificationResult>;
}

export class SCACareerStateAdapter
  implements CareerStateProvider
{
  constructor(
    private readonly runtime:
      | ExistingSCARuntime
      | null = null,
  ) {}

  async getCareerState(): Promise<CareerState> {
    if (this.runtime) {
      return this.runtime.getCareerState();
    }

    return {
      version: 1,
      identityAnchor: undefined,
      targetRoles: [],
      hardSkills: [],
      softSkills: [],
      achievements: [],
      constraints: {},
      source: "SCA",
      updatedAt: Date.now(),
    };
  }
}

export class SCARuntimeProvider
  implements SCAProvider
{
  readonly id = "sca.runtime";

  private readonly fallback =
    new NullSCAProvider();

  constructor(
    private readonly runtime:
      | ExistingSCARuntime
      | null = null,
  ) {}

  search = {
    search: async (
      request: JobSearchRequest,
      signal?: AbortSignal,
    ) => {
      if (!this.runtime) {
        return this.fallback.search.search(
          request,
          signal,
        );
      }

      return this.runtime.searchJobs(
        request,
        signal,
      );
    },
  };

  inspection = {
    inspect: async (
      jobId: string,
      signal?: AbortSignal,
    ) => {
      if (!this.runtime) {
        return this.fallback.inspection.inspect(
          jobId,
          signal,
        );
      }

      return this.runtime.inspectJob(
        jobId,
        signal,
      );
    },
  };

  application = {
    prepare: async (
      request: ApplyRequest,
      signal?: AbortSignal,
    ): Promise<ApplyPreparation> => {
      if (!this.runtime) {
        return this.fallback.application.prepare(
          request,
          signal,
        );
      }

      return this.runtime.prepareApply(request, signal);
    },

    execute: async (
      missionId: string,
      approvalToken?: string,
      signal?: AbortSignal,
    ): Promise<ActionReceipt> => {
      if (!this.runtime) {
        return this.fallback.application.execute(
          missionId,
          approvalToken,
          signal,
        );
      }

      return this.runtime.executeApply(
        missionId,
        approvalToken,
        signal,
      );
    },

    verify: async (
      missionId: string,
      signal?: AbortSignal,
    ): Promise<VerificationResult> => {
      if (!this.runtime) {
        return this.fallback.application.verify(
          missionId,
          signal,
        );
      }

      return this.runtime.verifyApply(missionId, signal);
    },
  };
}
