/**
 * SCA Event → DSH Evidence Mapper
 *
 * ⚠️ 这是 DSH Plugin 中 OBSERVED Evidence 的唯一合法来源。
 *
 * ⚠️ Authority Gate（Phase E.5 修正）：
 *   本 Mapper 不是第二个 Authority Gate，而是 ProvenanceVerifier 的消费者/适配器。
 *   核心校验逻辑在 contract/evidence-authority.ts（纯函数，可测试）。
 *
 * 权威链：
 *   Raw Observation (content_script)
 *     → processObservation() [ProvenanceVerifier]
 *     → observation event + interpretation event (Event Store)
 *     → getEventsByChain() 读取
 *     → extractAuthorizedObservations() 校验
 *     → OBSERVED Evidence
 *
 * 不满足 ProvenanceVerifier 条件的 observation 只能视为 RAW，
 * 不能提升为 OBSERVED Evidence。
 */

import type {
  Evidence,
  Job,
  JobMatch,
} from "../contract/types";
import type {
  SovereigntyEvent,
  InteractionState,
} from "@sca/shared/types";
import { getDb } from "@sca/service-worker/db";

// 纯函数层：Authority Gate 核心逻辑（可独立测试）
export {
  isAuthorizedObservation,
  extractAuthorizedObservations,
  mapAuthorizedObservationToEvidence,
  mapInterpretationToEvidence,
  buildContaminationScenarios,
} from "../contract/evidence-authority";

// ============================================================
// Event Store 读取（运行时依赖）
// ============================================================

export async function getEventsByChain(
  chainId: string,
): Promise<SovereigntyEvent[]> {
  const db = await getDb();
  const tx = db.transaction("events", "readonly");
  const events = await tx.store.index("by_chain").getAll(chainId);
  await tx.done;
  return events.sort((a, b) => a.ts - b.ts);
}

export async function getRecentObservations(
  limit = 50,
): Promise<SovereigntyEvent[]> {
  const db = await getDb();
  const tx = db.transaction("events", "readonly");
  const index = tx.store.index("by_type");
  const cursor = await index.openCursor("observation", "prev");
  const events: SovereigntyEvent[] = [];
  let c = cursor;
  while (c && events.length < limit) {
    events.push(c.value);
    c = await c.continue();
  }
  await tx.done;
  return events;
}

// ============================================================
// Evidence 映射（仅内部使用，外部必须通过 extractAuthorizedObservations）
// ============================================================

// ============================================================
// 公开 API：从 chain 提取 Evidence
// ============================================================

/**
 * 从一个 chainId 的事件流中提取所有 Evidence。
 *
 * ⚠️ OBSERVED 只包含已通过 ProvenanceVerifier 校验的 observation。
 * 未授权的 observation 会被静默过滤（不抛出，不伪造）。
 *
 * DERIVED 包含所有 interpretation（interpretation 本身就是 ProvenanceVerifier 的输出）。
 */
export async function extractEvidenceFromChain(
  chainId: string,
): Promise<Evidence[]> {
  const events = await getEventsByChain(chainId);
  const evidence: Evidence[] = [];

  // OBSERVED：仅提取已授权的
  evidence.push(...extractAuthorizedObservations(events));

  // DERIVED：interpretation 本身就是 ProvenanceVerifier 的输出
  for (const event of events) {
    if (event.type === "interpretation") {
      evidence.push(mapInterpretationToEvidence(event));
    }
  }

  return evidence;
}

// ============================================================
// Job 映射
// ============================================================

/**
 * 将 SCA InteractionState 映射为 DSH Job。
 *
 * ⚠️ 关键约束：
 *   Job.evidence 必须包含已授权的 OBSERVED Evidence。
 *   如果该 chainId 下没有已授权的 observation，Job.evidence 中将不包含 OBSERVED，
 *   调用方应据此判断该 Job 是否可信。
 *
 * InteractionState 是 SCA 从事件流投影出的状态，
 * 但其字段（title/company/salary 等）的权威性来自背后的 observation event。
 */
export async function mapInteractionStateToJob(
  state: InteractionState,
): Promise<Job> {
  const evidence = await extractEvidenceFromChain(state.companyId);

  const interpEvidence = evidence.find(
    (e) =>
      e.authority === "DERIVED" &&
      e.claimKey === "interpretation:job_analysis",
  );
  const matchScore =
    (interpEvidence?.value as any)?.matchScore ?? state.counterpartyScore;

  return {
    id: state.companyId,
    title: state.jobTitle || "未知岗位",
    company: state.companyName,
    location: state.location,
    salary: state.salary,
    platform: state.platforms?.[0],
    url: state.chatUrl || "",
    evidence,
    matchScore: typeof matchScore === "number" ? matchScore : undefined,
  };
}

/**
 * 从一组 InteractionState 批量映射为 Job[]，按匹配度降序排列。
 *
 * ⚠️ 仅返回有已授权 OBSERVED Evidence 的 Job。
 * 没有经过 ProvenanceVerifier 的状态不会被返回为可信 Job。
 */
export async function mapInteractionStatesToJobs(
  states: InteractionState[],
  limit?: number,
): Promise<Job[]> {
  const jobs = await Promise.all(
    states.map((s) => mapInteractionStateToJob(s)),
  );

  // 仅保留有 OBSERVED evidence 的 Job
  const trustedJobs = jobs.filter((job) =>
    job.evidence.some((e) => e.authority === "OBSERVED"),
  );

  trustedJobs.sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));

  return limit ? trustedJobs.slice(0, limit) : trustedJobs;
}

/**
 * 从 chainId 的事件中提取 JobMatch。
 */
export async function extractJobMatchFromChain(
  chainId: string,
  jobId: string,
): Promise<JobMatch | undefined> {
  const events = await getEventsByChain(chainId);
  const interpEvent = events.find((e) => e.type === "interpretation");

  if (!interpEvent) return undefined;

  const payload = interpEvent.payload as InterpretationPayload;
  const scoreTag = payload.riskTags?.find(
    (t) =>
      t.label?.includes("契合度评估") ||
      (t.label?.includes("匹配") &&
        !t.label?.includes("率") &&
        !t.label?.includes("风险")),
  );

  const strengths: string[] = [];
  const gaps: string[] = [];
  const risks: string[] = [];

  for (const tag of payload.riskTags || []) {
    if (
      tag.label?.includes("风险") ||
      (tag.confidence > 0.7 && tag.label?.includes("高压"))
    ) {
      risks.push(tag.label);
    } else if (tag.confidence > 0.5) {
      strengths.push(tag.label);
    } else {
      gaps.push(tag.label);
    }
  }

  return {
    jobId,
    score: scoreTag ? Math.round(scoreTag.confidence * 100) : 0,
    strengths,
    gaps,
    risks,
    derivedFromEvidenceIds: [interpEvent.id],
  };
}

// ============================================================
// ⚠️ P1-2 Fix: mapObservationToEvidence REMOVED.
//
// Previously, this function allowed callers to bypass the Authority Gate
// by directly mapping any observation event to Evidence without checking
// isAuthorizedObservation().
//
// The only legitimate way to get OBSERVED Evidence is through:
//   extractAuthorizedObservations(events) → filters via isAuthorizedObservation()
//
// If you need to map a single authorized observation, use:
//   mapAuthorizedObservationToEvidence(event) — but ONLY after verifying
//   isAuthorizedObservation(event, chainEvents) returns true.
//
// No backward-compatibility export is provided. Any code using this function
// must be updated to use extractAuthorizedObservations() instead.
// ============================================================
