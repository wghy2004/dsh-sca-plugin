/**
 * Authority Model —— 四种事实来源的正式定义
 *
 * ⚠️ Phase F-1.1: 移除 trust 数值语义。
 *
 * Authority 描述的是认识论来源/证明层级，不是同一坐标系里的概率。
 *
 *   OBSERVED  = reality evidence（现实证据）
 *   DERIVED   = deterministic conclusion（确定性结论）
 *   INFERRED  = epistemic hypothesis（认识论假设）
 *   RETRACTED = invalidated claim（已失效声明）
 *
 * 它们属于不同语义类型，不能用 1.0 > 0.5 这样的数值比较。
 *
 * 如果需要可信度，使用 Evidence.confidence（对具体 Claim 的置信度），
 * 而不是 Authority 本身的 trust。
 *
 * 权威链：
 *   REALITY
 *      │
 *      ▼
 *   OBSERVED ─── 现实世界经过 ProvenanceVerifier 授权的事实
 *      │
 *      ▼
 *   DERIVED ──── 由确定性规则从 OBSERVED 推导出来的状态
 *      │
 *      ▼
 *   INFERRED ─── LLM / Matcher / 推理系统产生的判断
 *      │
 *      ▼
 *   RETRACTED ── 之前获得的 Evidence / Claim 不再有效
 */

import type { Authority, Evidence } from "./types";

// ============================================================
// 四种 Authority 的正式定义
// ============================================================

export interface AuthorityDefinition {
  authority: Authority;
  name: string;
  description: string;
  /** 唯一合法的产生者 */
  producer: string;
  /** 认识论分类：reality / deterministic / hypothesis / invalidated */
  epistemicClass: "reality" | "deterministic" | "hypothesis" | "invalidated";
  /** 是否可以作为 Mission Completion 的验证依据 */
  canVerifyCompletion: boolean;
  /** 典型示例 */
  examples: string[];
}

export const AUTHORITY_MODEL: Record<Authority, AuthorityDefinition> = {
  OBSERVED: {
    authority: "OBSERVED",
    name: "Observed Reality",
    description:
      "现实世界经过 ProvenanceVerifier 授权的事实。必须来自真实浏览器观察，且存在对应的 interpretation 事件（证明经过了 processObservation）。",
    producer: "SCA Runtime / ProvenanceVerifier (processObservation)",
    epistemicClass: "reality",
    canVerifyCompletion: true,
    examples: [
      'page.text = "投递成功"',
      'page.title = "Java后端工程师-字节跳动"',
      'page.url = "https://zhipin.com/job_detail/123"',
    ],
  },

  DERIVED: {
    authority: "DERIVED",
    name: "Deterministically Derived",
    description:
      "由确定性规则从 OBSERVED 推导出来的状态。不引入新的现实事实，只是对已有事实的语义解释。",
    producer: "Evidence Mapper / Verification Engine / Rule Engine",
    epistemicClass: "deterministic",
    canVerifyCompletion: false, // DERIVED 不能单独验证，必须追溯到 OBSERVED
    examples: [
      'application.status = SUBMITTED （从 page.text="投递成功" 推导）',
      'job.salary.monthly = 30000 （从 page.text="30K-40K" 解析）',
      'match.score = 85 （从 interpretation.riskTags 提取）',
    ],
  },

  INFERRED: {
    authority: "INFERRED",
    name: "Model Inferred",
    description:
      "LLM / Matcher / 推理系统产生的判断。包含不确定性，不能作为现实事实的唯一依据。",
    producer: "LLM / Vector Matcher / Heuristic Engine",
    epistemicClass: "hypothesis",
    canVerifyCompletion: false,
    examples: [
      "该岗位与你的技术背景高度匹配",
      "这家公司可能存在加班文化",
      "这个职位可能已经关闭",
    ],
  },

  RETRACTED: {
    authority: "RETRACTED",
    name: "Retracted Claim",
    description:
      "之前获得的 Evidence / Claim 不再有效。可能因为页面刷新、信息更正、或被新的 OBSERVED 证伪。",
    producer: "EvidenceFactory.retract() / ProvenanceVerifier",
    epistemicClass: "invalidated",
    canVerifyCompletion: false,
    examples: [
      "之前观察到的薪资信息已被新页面覆盖",
      "岗位状态从'招聘中'变为'已关闭'",
    ],
  },
};

// ============================================================
// Authority 层级规则（基于认识论分类，而非数值 trust）
// ============================================================

/**
 * Authority 冲突解决：基于认识论层级，而非数值 trust。
 *
 * 层级：reality > deterministic > hypothesis > invalidated
 *
 * 注意：这不是"概率大小"比较，而是"证明来源"的优先级。
 * 一条 OBSERVED 事实永远比一条 INFERRED 假设更有权威，
 * 即使 INFERRED 的 confidence 很高。
 */
const EPISTEMIC_PRIORITY: Record<AuthorityDefinition["epistemicClass"], number> = {
  reality: 3,
  deterministic: 2,
  hypothesis: 1,
  invalidated: 0,
};

export function resolveAuthorityConflict(
  a: Evidence,
  b: Evidence,
): Evidence {
  const priorityA = EPISTEMIC_PRIORITY[AUTHORITY_MODEL[a.authority]?.epistemicClass ?? "hypothesis"];
  const priorityB = EPISTEMIC_PRIORITY[AUTHORITY_MODEL[b.authority]?.epistemicClass ?? "hypothesis"];
  return priorityA >= priorityB ? a : b;
}

/**
 * 检查 Evidence 是否可以作为 Completion 验证依据。
 * 只有 OBSERVED 可以。
 */
export function canVerifyCompletion(evidence: Evidence): boolean {
  return AUTHORITY_MODEL[evidence.authority]?.canVerifyCompletion ?? false;
}

/**
 * 检查一组 Evidence 中是否存在足够的 OBSERVED 依据。
 *
 * Completion Gate 的核心：没有 OBSERVED 就不能 COMPLETED。
 */
export function hasSufficientObservedEvidence(
  evidence: Evidence[],
  minCount = 1,
): boolean {
  const observed = evidence.filter((e) => e.authority === "OBSERVED");
  return observed.length >= minCount;
}

// ============================================================
// DERIVED Evidence 构造辅助
//
// confirmed = true 是 DERIVED，不是 OBSERVED。
// 这些函数帮助构造从 OBSERVED 推导的 DERIVED claim。
// ============================================================

/**
 * 从 OBSERVED 页面文本推导出 application.status = SUBMITTED。
 *
 * 这是一个 DERIVED claim，必须追溯到上游 OBSERVED evidence。
 */
export function deriveApplicationSubmitted(
  fromObservedId: string,
  observedText: string,
): { claimKey: string; value: unknown; derivedFrom: string } {
  return {
    claimKey: "application.status",
    value: "SUBMITTED",
    derivedFrom: fromObservedId,
  };
}

/**
 * 从 OBSERVED 页面文本推导出 application.status = REJECTED。
 */
export function deriveApplicationRejected(
  fromObservedId: string,
  observedText: string,
): { claimKey: string; value: unknown; derivedFrom: string } {
  return {
    claimKey: "application.status",
    value: "REJECTED",
    derivedFrom: fromObservedId,
  };
}

// ============================================================
// Authority 不变量断言
// ============================================================

/**
 * 断言 Authority 层级不变量：
 *   1. OBSERVED 必须有 source（来自真实观察）
 *   2. INFERRED 必须有 confidence < 1.0（不确定性）
 *   3. RETRACTED 必须有 retractedAt
 *
 * 注意：confidence 是对具体 Claim 的置信度，不是 Authority 本身的 trust。
 * OBSERVED 的 confidence 可以是 1.0（事实确定），
 * INFERRED 的 confidence 必须 < 1.0（假设不确定）。
 */
export function assertAuthorityInvariants(evidence: Evidence): void {
  if (evidence.authority === "OBSERVED") {
    if (!evidence.source) {
      throw new Error(
        `AUTHORITY_INVARIANT: OBSERVED evidence ${evidence.id} must have source`,
      );
    }
  }

  if (evidence.authority === "INFERRED") {
    if (evidence.confidence !== undefined && evidence.confidence >= 1.0) {
      throw new Error(
        `AUTHORITY_INVARIANT: INFERRED evidence ${evidence.id} must have confidence < 1.0 (got ${evidence.confidence})`,
      );
    }
  }

  if (evidence.authority === "RETRACTED") {
    if (!evidence.retractedAt) {
      throw new Error(
        `AUTHORITY_INVARIANT: RETRACTED evidence ${evidence.id} must have retractedAt`,
      );
    }
  }
}
