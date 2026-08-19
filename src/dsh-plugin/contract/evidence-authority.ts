/**
 * Evidence Authority Gate —— 纯函数层
 *
 * ⚠️ 这是 OBSERVED Authority 的核心校验逻辑，不依赖任何运行时模块（chrome/IDB/fetch）。
 * 可以在任何环境中测试，包括 Node.js unit test。
 *
 * 权威链：
 *   Raw Observation (content_script)
 *     → processObservation() [ProvenanceVerifier]
 *     → observation event
 *     → interpretation event (interpretation.observationId === observation.id)
 *     → isAuthorizedObservation() 校验
 *     → OBSERVED Evidence
 *
 * 任何不满足校验条件的 observation 都是 RAW，不能提升为 OBSERVED。
 */

import type {
  SovereigntyEvent,
  ObservationPayload,
  InterpretationPayload,
} from "@sca/shared/types";
import type { Evidence, EvidenceSource } from "./types";

const SCA_OBSERVATION_PROVIDER = "sca.observation";
const SCA_INTERPRETATION_PROVIDER = "sca.interpretation";

/**
 * 合法的 observation 来源。
 * 必须是真实浏览器观察，不能是 hub/cloud 等非浏览器来源。
 */
const AUTHORIZED_OBSERVATION_SOURCES = new Set([
  "content_script",
  "service_worker",
]);

/**
 * 验证一个 observation event 是否经过了 SCA 的 ProvenanceVerifier（processObservation）。
 *
 * SCA 的验证链：
 *   content_script 捕获原始观察
 *     → processObservation() 被调用
 *     → 写入 observation event
 *     → 写入 interpretation event（包含云端分析、匹配度评分、风险标签）
 *
 * 因此，一个"已授权的 OBSERVED"必须同时满足：
 *   1. event.type === "observation"
 *   2. event.source ∈ AUTHORIZED_OBSERVATION_SOURCES
 *   3. 同一 chainId 下存在对应的 interpretation event
 *      （interpretation.observationId === observation.id）
 *
 * 不满足这些条件的 observation 是 RAW，不能提升为 OBSERVED。
 *
 * @param event 待验证的 observation event
 * @param chainEvents 同一 chainId 下的所有事件（用于查找对应的 interpretation）
 * @returns 是否为已授权的 OBSERVED
 */
export function isAuthorizedObservation(
  event: SovereigntyEvent,
  chainEvents: SovereigntyEvent[],
): boolean {
  // 条件 1: 必须是 observation 类型
  if (event.type !== "observation") return false;

  // 条件 2: 来源必须是真实浏览器观察
  if (!AUTHORIZED_OBSERVATION_SOURCES.has(event.source)) {
    return false;
  }

  // 条件 3: 必须存在对应的 interpretation（ProvenanceVerifier 的输出）
  const observationId = event.id;
  const hasInterpretation = chainEvents.some(
    (e) =>
      e.type === "interpretation" &&
      (e.payload as InterpretationPayload).observationId === observationId,
  );

  return hasInterpretation;
}

/**
 * 从事件链中提取所有已授权的 OBSERVED Evidence。
 * 未经过 ProvenanceVerifier 的 observation 会被过滤掉。
 *
 * 这是 OBSERVED Evidence 的唯一合法构造入口。
 */
export function extractAuthorizedObservations(
  chainEvents: SovereigntyEvent[],
): Evidence[] {
  return chainEvents
    .filter((e) => isAuthorizedObservation(e, chainEvents))
    .map((e) => mapAuthorizedObservationToEvidence(e));
}

/**
 * 将已授权的 SCA Observation 映射为 OBSERVED Evidence。
 *
 * 注意：此函数假设调用方已经通过 isAuthorizedObservation() 验证。
 * 外部不应直接调用此函数，应使用 extractAuthorizedObservations()。
 */
export function mapAuthorizedObservationToEvidence(
  event: SovereigntyEvent,
): Evidence {
  const payload = event.payload as ObservationPayload;
  const source: EvidenceSource = {
    providerId: SCA_OBSERVATION_PROVIDER,
    uri: payload.pageUrl,
    observedAt: event.ts,
    locator: payload.selector,
  };

  return {
    id: event.id,
    claimKey: `observation:${payload.selector || "page"}`,
    value: {
      pageUrl: payload.pageUrl,
      pageTitle: payload.pageTitle,
      extractedText: payload.extractedText,
      domEntities: payload.domEntities,
    },
    authority: "OBSERVED",
    source,
    confidence: 1.0,
    createdAt: event.ts,
  };
}

/**
 * 将 SCA Interpretation 映射为 DERIVED Evidence。
 *
 * Interpretation 是 ProvenanceVerifier 对 Observation 的分析结果，
 * 属于推理性计算（云端模型分析 + 规则匹配），不是原始观察。
 */
export function mapInterpretationToEvidence(
  event: SovereigntyEvent,
): Evidence {
  const payload = event.payload as InterpretationPayload;
  const source: EvidenceSource = {
    providerId: SCA_INTERPRETATION_PROVIDER,
    observedAt: event.ts,
  };

  const scoreTag = payload.riskTags?.find(
    (t) =>
      t.label?.includes("契合度评估") ||
      (t.label?.includes("匹配") &&
        !t.label?.includes("率") &&
        !t.label?.includes("风险")),
  );

  return {
    id: event.id,
    claimKey: "interpretation:job_analysis",
    value: {
      summary: payload.summary,
      riskTags: payload.riskTags,
      entities: payload.entities,
      matchScore: scoreTag ? Math.round(scoreTag.confidence * 100) : undefined,
      modelVersion: payload.modelVersion,
      isLocal: payload.isLocal,
      observationId: payload.observationId,
    },
    authority: "DERIVED",
    source,
    confidence: scoreTag?.confidence,
    createdAt: event.ts,
  };
}

// ============================================================
// 污染测试辅助：构造各种事件场景
// ============================================================

export interface ContaminationTestScenario {
  name: string;
  description: string;
  events: SovereigntyEvent[];
  expectedAuthorizedCount: number;
  expectedAuthorizedIds: string[];
}

/**
 * 构造污染测试场景。
 * 用于验证 Authority Gate 的抗污染能力。
 */
export function buildContaminationScenarios(): ContaminationTestScenario[] {
  const baseObservation = (
    id: string,
    chainId: string,
    source: SovereigntyEvent["source"] = "content_script",
  ): SovereigntyEvent => ({
    id,
    ts: 1000,
    type: "observation",
    payload: {
      chainId,
      pageUrl: "https://example.com/job/123",
      pageTitle: "Java 后端工程师",
      extractedText: "岗位职责：...",
      selector: "Container",
    } as ObservationPayload,
    source,
    traceHash: "hash1",
    chainId,
  });

  const baseInterpretation = (
    id: string,
    observationId: string,
    chainId: string,
  ): SovereigntyEvent => ({
    id,
    ts: 1001,
    type: "interpretation",
    payload: {
      chainId,
      observationId,
      riskTags: [{ label: "契合度评估", confidence: 0.85 }],
      summary: "匹配度较高",
      modelVersion: "v1",
      isLocal: false,
    } as InterpretationPayload,
    source: "cloud",
    traceHash: "hash2",
    chainId,
  });

  return [
    {
      name: "正常情况：observation + 对应 interpretation",
      description: "observation 有对应的 interpretation，应该被授权为 OBSERVED",
      events: [
        baseObservation("obs-1", "chain-1"),
        baseInterpretation("interp-1", "obs-1", "chain-1"),
      ],
      expectedAuthorizedCount: 1,
      expectedAuthorizedIds: ["obs-1"],
    },
    {
      name: "污染 1：observation 但没有 interpretation",
      description: "只有 observation 没有 interpretation，说明未经过 ProvenanceVerifier，不能授权",
      events: [baseObservation("obs-2", "chain-2")],
      expectedAuthorizedCount: 0,
      expectedAuthorizedIds: [],
    },
    {
      name: "污染 2：observation + interpretation 但 observationId 不匹配",
      description: "interpretation.observationId 不等于 observation.id，不能证明是同一个观察的验证",
      events: [
        baseObservation("obs-3", "chain-3"),
        baseInterpretation("interp-3", "obs-OTHER", "chain-3"),
      ],
      expectedAuthorizedCount: 0,
      expectedAuthorizedIds: [],
    },
    {
      name: "污染 3：observation 来源是 hub（非浏览器）",
      description: "source=hub 不是真实浏览器观察，不能授权为 OBSERVED",
      events: [
        baseObservation("obs-4", "chain-4", "hub"),
        baseInterpretation("interp-4", "obs-4", "chain-4"),
      ],
      expectedAuthorizedCount: 0,
      expectedAuthorizedIds: [],
    },
    {
      name: "污染 4：observation 来源是 cloud（非浏览器）",
      description: "source=cloud 不是真实浏览器观察，不能授权为 OBSERVED",
      events: [
        baseObservation("obs-5", "chain-5", "cloud"),
        baseInterpretation("interp-5", "obs-5", "chain-5"),
      ],
      expectedAuthorizedCount: 0,
      expectedAuthorizedIds: [],
    },
    {
      name: "混合：正常 observation + 污染 observation 在同一 chain",
      description: "同一 chain 下有正常和污染的 observation，只有正常的被授权",
      events: [
        baseObservation("obs-6a", "chain-6"),
        baseObservation("obs-6b", "chain-6", "hub"),
        baseInterpretation("interp-6a", "obs-6a", "chain-6"),
        baseInterpretation("interp-6b", "obs-6b", "chain-6"),
      ],
      expectedAuthorizedCount: 1,
      expectedAuthorizedIds: ["obs-6a"],
    },
    {
      name: "多个正常 observation 在同一 chain",
      description: "多个 observation 都有对应 interpretation，全部被授权",
      events: [
        baseObservation("obs-7a", "chain-7"),
        baseObservation("obs-7b", "chain-7"),
        baseInterpretation("interp-7a", "obs-7a", "chain-7"),
        baseInterpretation("interp-7b", "obs-7b", "chain-7"),
      ],
      expectedAuthorizedCount: 2,
      expectedAuthorizedIds: ["obs-7a", "obs-7b"],
    },
  ];
}
