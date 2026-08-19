/**
 * SCACoreRuntime —— ExistingSCARuntime 的真实实现
 *
 * 这是 DSH Plugin 与 SCA Core 之间的焊接层。
 *
 * 架构定位：
 *   DSH Plugin (Capability Contract)
 *     ↓
 *   SCACoreRuntime (本文件)
 *     ↓
 *   SCA Core (db / seed-generator / shadow-tab-executor / policy / projection)
 *     ↓
 *   Reality (Browser / Job Site / Mail)
 *
 * ⚠️ OBSERVED Authority：
 *   本文件是唯一允许构造 authority="OBSERVED" Evidence 的地方，
 *   且必须通过 evidence-mapper 从 SCA Event Store 提取，
 *   不能凭空构造。
 *
 * ⚠️ 不修改 SCA 源码：
 *   所有 SCA 模块通过 import 引用，只读使用。
 *   SCA 的事件账本、Observation、Constitution、WDL、Shadow Tab 等结构保持不变。
 */

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
import type { ExistingSCARuntime } from "../adapter/sca-runtime-adapter";

// SCA Core 模块引用（只读）
import { getActiveProfile, getConstitution, appendIntent, commitSovereigntyTransaction, getDb } from "@sca/service-worker/db";
import { SeedGenerator } from "@sca/service-worker/seed-generator";
import { shadowTabExecutor } from "@sca/service-worker/shadow-tab-executor";
import { processObservation, evaluateActionGate, computeProfileSimilarity } from "@sca/service-worker/policy";
import { getInteractionStates, invalidateProjectionCache } from "@sca/service-worker/projection";
import type { WhitepaperAnalysisPayload, UserConstitution, InteractionState, IntentPayload, ObservationPayload } from "@sca/shared/types";
import { createJobFingerprint, normalizeJobUrl } from "@sca/shared/event-factory";

import {
  extractEvidenceFromChain,
  mapInteractionStatesToJobs,
  mapInteractionStateToJob,
  extractJobMatchFromChain,
  getEventsByChain,
  mapObservationToEvidence,
  extractAuthorizedObservations,
  isAuthorizedObservation,
} from "./evidence-mapper";

// ============================================================
// 投递验证：页面文本模式
//
// 这些模式用于从 OBSERVED Evidence 的 extractedText 中判断投递状态。
// 只有页面文本匹配这些模式，才能确认投递成功/失败。
// decision event（FORM_DISPATCH 等）不能作为确认依据。
// ============================================================

const APPLICATION_SUCCESS_PATTERNS: RegExp[] = [
  /已投递|投递成功|申请成功|已申请|简历已送达|投递已完成|您已成功投递/,
  /application\s+submitted|applied\s+successfully|resume\s+sent/i,
];

const APPLICATION_FAILURE_PATTERNS: RegExp[] = [
  /投递失败|申请失败|职位已关闭|该职位已结束|无法投递|简历未送达/,
  /position\s+closed|application\s+failed|unable\s+to\s+apply/i,
];

// ============================================================
// 工具函数
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateDSHChainId(prefix: string): string {
  return `dsh_${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================
// SCACoreRuntime 实现
// ============================================================

export class SCACoreRuntime implements ExistingSCARuntime {
  /**
   * Phase B: getCareerState
   *
   * SCA Profile = State Authority
   * DSH CareerState = Semantic Projection
   *
   * 直接复用 getActiveProfile() + getConstitution()，
   * 不重新读取数据库，不创建第二份 Profile。
   */
  async getCareerState(): Promise<CareerState> {
    const profile = await getActiveProfile();
    const constitution = await getConstitution();

    if (!profile) {
      return {
        version: 1,
        targetRoles: [],
        hardSkills: [],
        softSkills: [],
        achievements: [],
        constraints: {},
        source: "SCA",
        updatedAt: Date.now(),
      };
    }

    const prefs = constitution.preferences || {};
    const remoteBoundary = constitution.contextualBoundaries?.find(
      (b) => b.id === "cb_remote_only" && b.active,
    );

    const targetLocations = profile.job_seeking?.target_locations || [];
    const preferredLocations = prefs.preferredLocations || [];

    return {
      version: 1,
      identityAnchor: profile.identity_anchor,
      targetRoles: profile.job_seeking?.target_roles || [],
      hardSkills: profile.capabilities?.hard_skills || [],
      softSkills: profile.capabilities?.soft_skills || [],
      achievements: profile.capabilities?.achievements || [],
      constraints: {
        location:
          targetLocations[0] || preferredLocations[0] || undefined,
        minimumSalary: prefs.minSalary,
        maximumSalary: prefs.maxSalary,
        blockedKeywords: prefs.blockedKeywords,
        blockedPlatforms: prefs.blockedPlatforms,
        preferredPlatforms: prefs.activePlatforms,
        remoteOnly: !!remoteBoundary,
        minimumMatchScore: prefs.minCompleteness,
      },
      source: "SCA",
      updatedAt: Date.now(),
    };
  }

  // ============================================================
  // Phase C: searchJobs
  //
  // DSH 负责"我要什么"，SCA 负责"现实世界怎么找"。
  //
  // 流程：
  //   CareerState + SearchRequest
  //     → SeedGenerator.generateOptimalSeeds
  //     → shadowTabExecutor.enqueue
  //     → shadowTabExecutor.startTraversal
  //     → (等待遍历完成)
  //     → getInteractionStates (投影)
  //     → Job[] + Evidence[]
  // ============================================================

  async searchJobs(
    request: JobSearchRequest,
    signal?: AbortSignal,
  ): Promise<{ jobs: Job[]; evidence: Evidence[] }> {
    const searchChainId = generateDSHChainId("search");

    // 1. 生成寻源种子（复用 SCA SeedGenerator）
    const seeds = await SeedGenerator.generateOptimalSeeds(1);

    if (seeds.length === 0) {
      return { jobs: [], evidence: [] };
    }

    // 2. 构造遍历任务并入队
    const tasks = seeds.map((seed) => ({
      url: seed.url,
      chainId: `seed_${seed.platform}_${Math.abs(this.hashCode(seed.url)).toString(36)}`,
      title: seed.title,
      taskType: "SEED" as const,
      metadata: seed.tactics,
    }));

    const enqueued = await shadowTabExecutor.enqueue(tasks);

    if (enqueued === 0) {
      return { jobs: [], evidence: [] };
    }

    // 3. 启动遍历
    await shadowTabExecutor.startTraversal();

    // 4. 等待 Observation + Interpretation 进入 Event Store（最多 60 秒）
    //
    // ⚠️ Authority Gate（Phase E.5 修正）：
    //   不能仅等待 traversal 完成。traversal 完成 ≠ observation 已进入 Event Store
    //   ≠ interpretation（ProvenanceVerifier 输出）已写入。
    //
    //   必须等待每个 seed chainId 下存在：
    //     - observation event（真实页面观察）
    //     - interpretation event（ProvenanceVerifier 分析结果）
    //
    //   只有同时存在这两者，该 chainId 的 Job 才是"已授权的可信结果"。
    const deadline = Date.now() + 60_000;
    const pollInterval = 3_000;
    const seedChainIds = tasks.map((t) => t.chainId);

    while (Date.now() < deadline) {
      if (signal?.aborted) break;
      await sleep(pollInterval);

      // 检查每个 seed chainId 是否有已授权的 observation（有对应的 interpretation）
      let allAuthorized = true;
      let anyObservation = false;

      for (const chainId of seedChainIds) {
        const events = await getEventsByChain(chainId);
        const hasObservation = events.some((e) => e.type === "observation");
        const hasInterpretation = events.some(
          (e) => e.type === "interpretation",
        );

        if (hasObservation) anyObservation = true;
        if (!hasObservation || !hasInterpretation) {
          allAuthorized = false;
        }
      }

      // 至少有一个 seed 产生了 observation，且所有有 observation 的 seed 都有 interpretation
      if (anyObservation && allAuthorized) break;

      // 或者超过一半的 seed 有了完整的 observation + interpretation
      const authorizedCount = (
        await Promise.all(
          seedChainIds.map(async (cid) => {
            const evts = await getEventsByChain(cid);
            return evts.some((e) => e.type === "observation") &&
              evts.some((e) => e.type === "interpretation")
              ? 1
              : 0;
          }),
        )
      ).reduce((a, b) => a + b, 0);

      if (authorizedCount >= Math.ceil(seedChainIds.length / 2)) break;
    }

    // 5. 从投影读取结果
    invalidateProjectionCache();
    const states = await getInteractionStates();

    // 6. 筛选与本次搜索相关的结果（最近发现的、未关闭的）
    const now = Date.now();
    const recentStates = states.filter(
      (s) =>
        now - s.lastContact < 300_000 && // 5 分钟内的新发现
        s.stage !== "dropped" &&
        s.stage !== "rejected",
    );

    // 如果没有最近的新发现，返回所有活跃状态
    const candidateStates =
      recentStates.length > 0
        ? recentStates
        : states.filter(
            (s) => s.stage !== "dropped" && s.stage !== "rejected",
          );

    // 7. 应用请求约束过滤
    const filteredStates = this.applySearchConstraints(
      candidateStates,
      request,
    );

    // 8. 映射为 Job[]（包含 OBSERVED Evidence）
    const limit = request.limit ?? 20;
    const jobs = await mapInteractionStatesToJobs(filteredStates, limit);

    // 9. 收集所有相关 Evidence
    const allEvidence: Evidence[] = [];
    for (const job of jobs) {
      allEvidence.push(...job.evidence);
    }

    return { jobs, evidence: allEvidence };
  }

  // ============================================================
  // Phase D: inspectJob
  //
  // 职位详情复用现有 Observation Pipeline。
  // jobId 对应 SCA 的 companyId / chainId。
  //
  // 流程：
  //   jobId → 查找 InteractionState
  //     → 如有 URL 则触发观察
  //     → processObservation
  //     → 从 Event Store 读取详情
  //     → JobInspectResult
  // ============================================================

  async inspectJob(
    jobId: string,
    signal?: AbortSignal,
  ): Promise<JobInspectResult> {
    // 1. 从投影中查找该岗位
    const states = await getInteractionStates();
    const state = states.find((s) => s.companyId === jobId);

    if (!state) {
      // 尝试从 Event Store 直接查找
      const events = await getEventsByChain(jobId);
      if (events.length === 0) {
        throw new Error(`JOB_NOT_FOUND:${jobId}`);
      }
    }

    // 2. 如果有 chatUrl，触发真实浏览器观察
    //    ⚠️ 这不是 synthetic observation，而是通过 shadowTabExecutor 触发
    //    真实的浏览器页面加载，由 content_script 捕获原始观察，
    //    再经 processObservation（ProvenanceVerifier）写入 Event Store。
    if (state?.chatUrl) {
      await this.triggerJobObservation(state.chatUrl, jobId, signal);
    }

    // 3. 等待 Observation + Interpretation 进入 Event Store
    //    （最多 20 秒，确保经过 ProvenanceVerifier）
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) break;
      await sleep(2_000);

      const events = await getEventsByChain(jobId);
      const hasAuthorizedObservation = events.some((e) =>
        isAuthorizedObservation(e, events),
      );
      if (hasAuthorizedObservation) break;
    }

    // 4. 从 Event Store 提取已授权的 Evidence 和详情
    const job = state
      ? await mapInteractionStateToJob(state)
      : await this.buildJobFromEvents(jobId);

    // 5. 提取匹配度分析（DERIVED，来自 interpretation）
    const match = await extractJobMatchFromChain(jobId, jobId);

    return {
      missionId: generateDSHChainId("inspect"),
      job,
      match,
    };
  }

  // ============================================================
  // Phase E: applyJob 三段式
  // ============================================================

  /**
   * prepareApply —— 评估投递可行性，不产生外部副作用。
   *
   * 检查：
   *   - Profile 是否存在
   *   - 目标岗位是否已在活跃投递中（evaluateActionGate）
   *   - 平台是否被屏蔽
   */
  async prepareApply(
    request: ApplyRequest,
    _signal?: AbortSignal,
  ): Promise<ApplyPreparation> {
    const missionId = generateDSHChainId("apply");

    // 检查 Profile
    const profile = await getActiveProfile();
    if (!profile) {
      return {
        missionId,
        jobId: request.jobId,
        ready: false,
        blockers: ["PROFILE_NOT_FOUND: 职业画像未初始化"],
      };
    }

    // 检查是否已有活跃投递
    const states = await getInteractionStates();
    const targetState = states.find((s) => s.companyId === request.jobId);

    if (targetState) {
      const gate = await evaluateActionGate(
        request.jobId,
        [],
        "APPLY",
      );
      if (gate.block) {
        return {
          missionId,
          jobId: request.jobId,
          ready: false,
          blockers: gate.reason,
        };
      }
    }

    return {
      missionId,
      jobId: request.jobId,
      ready: true,
      planId: `plan_${missionId}`,
      estimatedDurationMs: 15_000,
    };
  }

  /**
   * executeApply —— 执行外部行动（触发投递）。
   *
   * 通过 appendIntent 写入 FORM_FILL 类型的 intent 事件，
   * shadowTabExecutor 的 outbox 处理器会消费并执行。
   *
   * 注意：accepted !== 现实世界成功，必须经过 verifyApply。
   */
  async executeApply(
    missionId: string,
    approvalToken?: string,
    _signal?: AbortSignal,
  ): Promise<ActionReceipt> {
    // 从 mission checkpoint 中恢复 jobId（简化实现：直接用 missionId 关联）
    // 在实际实现中，jobId 应该在 prepare 阶段存入 checkpoint
    const jobId = missionId; // 简化：实际应从 checkpoint 读取

    try {
      // 写入投递 intent，触发 SCA 的 outbox 处理
      const intent: IntentPayload = {
        chainId: jobId,
        intentType: "FORM_FILL",
        taskType: "JOB",
        metadata: {
          missionId,
          approvalToken: approvalToken || "user_approved",
          source: "dsh_plugin",
        },
      };

      await appendIntent(intent);

      // 触发 outbox 处理
      await shadowTabExecutor.startTraversal();

      // 等待执行开始
      await sleep(3_000);

      return {
        missionId,
        accepted: true,
        receiptId: `receipt_${missionId}`,
        evidence: [], // 执行阶段不返回 OBSERVED，verify 阶段才返回
      };
    } catch (err) {
      return {
        missionId,
        accepted: false,
        evidence: [],
        failure: {
          code: "APPLY_EXECUTION_ERROR",
          message: String(err),
          retryable: true,
        },
      };
    }
  }

  /**
   * verifyApply —— 基于已授权 OBSERVED Evidence 确认现实世界状态。
   *
   * ⚠️ Authority Gate（Phase E.5 修正）：
   *   不能用 FORM_DISPATCH / PLATFORM_DISPATCH 等 decision event 判断 confirmed。
   *   decision event 只证明"SCA 决定执行投递"，不证明"现实世界投递成功"。
   *
   *   confirmed 必须基于：
   *     1. 已授权的 OBSERVED Evidence（经过 ProvenanceVerifier）
   *     2. Evidence 内容表明投递成功（页面文本包含"已投递"/"申请成功"等）
   *
   *   权威链：
   *     Browser Action → Platform Response → Observation → ProvenanceVerifier
   *       → OBSERVED (application.status = submitted) → confirmed = true
   *
   *   没有满足条件的 OBSERVED Evidence，confirmed 必须为 false。
   */
  async verifyApply(
    missionId: string,
    signal?: AbortSignal,
  ): Promise<VerificationResult> {
    const jobId = missionId; // 简化：实际应从 checkpoint 读取

    // 等待 observation 进入 Event Store（轮询，最多 30 秒）
    // 注意：不等待 outbox 清空，因为 outbox 清空只表示"意图已消费"，不表示"结果已观察"
    const deadline = Date.now() + 30_000;
    let authorizedEvidence: Evidence[] = [];

    while (Date.now() < deadline) {
      if (signal?.aborted) break;
      await sleep(3_000);

      const events = await getEventsByChain(jobId);
      authorizedEvidence = extractAuthorizedObservations(events);

      // 只要有已授权的 observation 就停止等待（内容是否表明成功在下面判断）
      if (authorizedEvidence.length > 0) break;
    }

    // 如果没有已授权的 OBSERVED，直接返回未确认
    if (authorizedEvidence.length === 0) {
      return {
        missionId,
        confirmed: false,
        evidence: [],
        summary:
          "VERIFICATION_PENDING: 投递执行已发起，但尚未观察到经过 ProvenanceVerifier 验证的页面证据",
        failure: {
          code: "VERIFICATION_PENDING",
          message:
            "没有已授权的 OBSERVED Evidence。可能原因：页面未加载完成、观察未触发、或 ProvenanceVerifier 未完成分析。请稍后重试 verify。",
          retryable: true,
        },
      };
    }

    // ⚠️ Phase F-1.1: 给所有 verification evidence 打上 missionId 作用域标记
    // 防止跨 Mission 证据污染（EvidenceScopeValid 检查）
    const scopedEvidence = authorizedEvidence.map((e) => ({
      ...e,
      missionId,
      correlationId: missionId, // 简化：实际应使用 mission.correlationId
    }));

    // 检查 OBSERVED Evidence 内容是否表明投递成功
    // 这是 confirmed 的唯一合法依据
    const successEvidence = scopedEvidence.find((e) => {
      const value = e.value as any;
      const text = (value?.extractedText || value?.pageTitle || "") as string;
      return APPLICATION_SUCCESS_PATTERNS.some((pattern) =>
        pattern.test(text),
      );
    });

    // 检查是否有明确的失败观察
    const failureEvidence = scopedEvidence.find((e) => {
      const value = e.value as any;
      const text = (value?.extractedText || value?.pageTitle || "") as string;
      return APPLICATION_FAILURE_PATTERNS.some((pattern) =>
        pattern.test(text),
      );
    });

    if (successEvidence) {
      // ⚠️ Authority 分层（Phase F）：
      //   OBSERVED: page.text = "投递成功"  （现实事实）
      //   DERIVED:  application.status = SUBMITTED  （从 OBSERVED 确定性推导）
      //
      // confirmed = true 是 DERIVED 结论，不是 OBSERVED 事实本身。
      const actionId = `action_${missionId}`;
      const derivedEvidence: Evidence = {
        id: `derived_${missionId}_${Date.now()}`,
        claimKey: "application.status",
        value: "SUBMITTED",
        authority: "DERIVED",
        missionId,
        actionId,
        correlationId: missionId,
        source: {
          providerId: "sca.verification",
          observedAt: Date.now(),
        },
        confidence: 0.95,
        createdAt: Date.now(),
      };

      return {
        missionId,
        confirmed: true,
        evidence: [...scopedEvidence, derivedEvidence],
        summary: `投递已确认：页面观察到投递成功状态（OBSERVED evidenceId=${successEvidence.id} → DERIVED application.status=SUBMITTED）`,
      };
    }

    if (failureEvidence) {
      return {
        missionId,
        confirmed: false,
        evidence: scopedEvidence,
        summary: `投递失败：页面观察到失败状态（evidenceId=${failureEvidence.id}）`,
        failure: {
          code: "APPLICATION_REJECTED",
          message: "平台页面显示投递失败或职位已关闭",
          retryable: false,
        },
      };
    }

    // 有 OBSERVED 但内容不明确，返回未确认
    return {
      missionId,
      confirmed: false,
      evidence: scopedEvidence,
      summary:
        "VERIFICATION_AMBIGUOUS: 已观察到页面状态，但无法从文本中确认投递成功或失败",
      failure: {
        code: "VERIFICATION_AMBIGUOUS",
        message:
          "OBSERVED Evidence 存在，但内容不包含明确的投递成功/失败标识。需要更精确的页面观察或人工确认。",
        retryable: true,
      },
    };
  }

  // ============================================================
  // Internal helpers
  // ============================================================

  private applySearchConstraints(
    states: InteractionState[],
    request: JobSearchRequest,
  ): InteractionState[] {
    const constraints = request.constraints || {};
    let result = [...states];

    if (constraints.minimumMatchScore) {
      result = result.filter(
        (s) => (s.counterpartyScore || 0) >= constraints.minimumMatchScore!,
      );
    }

    if (constraints.location) {
      result = result.filter(
        (s) =>
          !s.location ||
          s.location.includes(constraints.location!) ||
          constraints.location!.includes(s.location),
      );
    }

    if (constraints.blockedKeywords) {
      result = result.filter((s) => {
        const text = `${s.jobTitle || ""} ${s.companyName || ""} ${s.summary || ""}`;
        return !constraints.blockedKeywords!.some((kw) =>
          text.toLowerCase().includes(kw.toLowerCase()),
        );
      });
    }

    if (constraints.blockedPlatforms) {
      result = result.filter(
        (s) =>
          !s.platforms ||
          !s.platforms.some((p) =>
            constraints.blockedPlatforms!.includes(p),
          ),
      );
    }

    // 按 query 关键词过滤（从 Job 文本中匹配）
    if (request.query) {
      const keywords = request.query.split(/\s+/).filter(Boolean);
      result = result.filter((s) => {
        const text = `${s.jobTitle || ""} ${s.summary || ""}`.toLowerCase();
        return keywords.some((kw) => text.includes(kw.toLowerCase()));
      });
    }

    return result;
  }

  private async triggerJobObservation(
    url: string,
    chainId: string,
    _signal?: AbortSignal,
  ): Promise<void> {
    // 通过 shadowTabExecutor 触发真实的浏览器页面加载。
    // content_script 会捕获原始观察，processObservation（ProvenanceVerifier）
    // 会将 observation + interpretation 写入 Event Store。
    //
    // ⚠️ 本方法不构造任何 observation，只触发浏览器行为。
    // OBSERVED Evidence 的唯一来源是 evidence-mapper 从 Event Store 读取。
    try {
      await shadowTabExecutor.enqueue([
        {
          url,
          chainId,
          title: "岗位详情",
          taskType: "JOB",
        },
      ]);
      await shadowTabExecutor.startTraversal();
    } catch {
      // 观察触发失败不阻断 inspect，返回已有数据
    }
  }

  private async buildJobFromEvents(chainId: string): Promise<Job> {
    const events = await getEventsByChain(chainId);
    const evidence = await extractEvidenceFromChain(chainId);

    const obsEvent = events.find((e) => e.type === "observation");
    const interpEvent = events.find((e) => e.type === "interpretation");

    const obsPayload = obsEvent?.payload as ObservationPayload | undefined;
    const interpPayload = interpEvent?.payload as any;

    return {
      id: chainId,
      title: obsPayload?.pageTitle || "未知岗位",
      url: obsPayload?.pageUrl || "",
      evidence,
      matchScore: interpPayload?.riskTags?.find(
        (t: any) =>
          t.label?.includes("契合度评估") ||
          (t.label?.includes("匹配") &&
            !t.label?.includes("率") &&
            !t.label?.includes("风险")),
      )
        ? Math.round(
            interpPayload.riskTags.find(
              (t: any) =>
                t.label?.includes("契合度评估") ||
                (t.label?.includes("匹配") &&
                  !t.label?.includes("率") &&
                  !t.label?.includes("风险")),
            ).confidence * 100,
          )
        : undefined,
    };
  }

  private hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
    }
    return hash;
  }
}
