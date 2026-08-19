/**
 * Authority Gate 污染测试
 *
 * ⚠️ Phase F: 验证 OBSERVED Evidence 的唯一合法来源必须经过 ProvenanceVerifier。
 *
 * 测试场景：
 *   1. 正常情况：observation + 对应 interpretation → OBSERVED
 *   2. 污染 1：observation 但没有 interpretation → 不产生 OBSERVED
 *   3. 污染 2：observation + interpretation 但 observationId 不匹配 → 不产生 OBSERVED
 *   4. 污染 3：observation 来源是 hub（非浏览器）→ 不产生 OBSERVED
 *   5. 污染 4：observation 来源是 cloud（非浏览器）→ 不产生 OBSERVED
 *   6. 混合：正常 + 污染 → 只有正常的被授权
 *   7. 多个正常 → 全部被授权
 *
 * 运行方式：npx tsx tests/authority-gate.contamination.test.ts
 */

import {
  isAuthorizedObservation,
  extractAuthorizedObservations,
  buildContaminationScenarios,
} from "../src/dsh-plugin/contract/evidence-authority";

// ============================================================
// 简单测试框架（不依赖 vitest）
// ============================================================

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, `${message} (expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)})`);
}

// ============================================================
// 测试：isAuthorizedObservation 单元测试
// ============================================================

console.log("\n=== Test Suite: isAuthorizedObservation ===");

// 构造基础事件
const makeObservation = (
  id: string,
  chainId: string,
  source: string = "content_script",
) => ({
  id,
  ts: 1000,
  type: "observation" as const,
  payload: { chainId, pageUrl: "https://example.com", pageTitle: "Test", extractedText: "", selector: "" },
  source: source as any,
  traceHash: "h1",
  chainId,
});

const makeInterpretation = (
  id: string,
  observationId: string,
  chainId: string,
) => ({
  id,
  ts: 1001,
  type: "interpretation" as const,
  payload: { chainId, observationId, riskTags: [], summary: "", modelVersion: "v1", isLocal: false },
  source: "cloud" as const,
  traceHash: "h2",
  chainId,
});

// 测试 1: 正常情况
{
  const obs = makeObservation("obs-1", "chain-1");
  const interp = makeInterpretation("interp-1", "obs-1", "chain-1");
  assert(
    isAuthorizedObservation(obs as any, [obs, interp] as any) === true,
    "正常 observation + 对应 interpretation 应该被授权",
  );
}

// 测试 2: 没有 interpretation
{
  const obs = makeObservation("obs-2", "chain-2");
  assert(
    isAuthorizedObservation(obs as any, [obs] as any) === false,
    "没有 interpretation 的 observation 不应该被授权",
  );
}

// 测试 3: interpretation.observationId 不匹配
{
  const obs = makeObservation("obs-3", "chain-3");
  const interp = makeInterpretation("interp-3", "obs-OTHER", "chain-3");
  assert(
    isAuthorizedObservation(obs as any, [obs, interp] as any) === false,
    "interpretation.observationId 不匹配不应该被授权",
  );
}

// 测试 4: source=hub
{
  const obs = makeObservation("obs-4", "chain-4", "hub");
  const interp = makeInterpretation("interp-4", "obs-4", "chain-4");
  assert(
    isAuthorizedObservation(obs as any, [obs, interp] as any) === false,
    "source=hub 的 observation 不应该被授权",
  );
}

// 测试 5: source=cloud
{
  const obs = makeObservation("obs-5", "chain-5", "cloud");
  const interp = makeInterpretation("interp-5", "obs-5", "chain-5");
  assert(
    isAuthorizedObservation(obs as any, [obs, interp] as any) === false,
    "source=cloud 的 observation 不应该被授权",
  );
}

// 测试 6: 非 observation 类型
{
  const decision = { id: "d-1", ts: 1000, type: "decision", payload: {}, source: "service_worker", traceHash: "h", chainId: "c" };
  assert(
    isAuthorizedObservation(decision as any, [decision] as any) === false,
    "非 observation 类型不应该被授权",
  );
}

// ============================================================
// 测试：extractAuthorizedObservations 集成测试
// ============================================================

console.log("\n=== Test Suite: extractAuthorizedObservations (Contamination Scenarios) ===");

const scenarios = buildContaminationScenarios();

for (const scenario of scenarios) {
  console.log(`\n  Scenario: ${scenario.name}`);
  console.log(`    ${scenario.description}`);

  const result = extractAuthorizedObservations(scenario.events as any);

  assertEqual(
    result.length,
    scenario.expectedAuthorizedCount,
    `${scenario.name}: 授权的 OBSERVED 数量`,
  );

  const resultIds = result.map((e) => e.id).sort();
  const expectedIds = [...scenario.expectedAuthorizedIds].sort();
  assertEqual(
    resultIds,
    expectedIds,
    `${scenario.name}: 授权的 OBSERVED ID 列表`,
  );

  // 验证所有返回的 evidence 都是 OBSERVED authority
  for (const ev of result) {
    assert(
      ev.authority === "OBSERVED",
      `${scenario.name}: evidence ${ev.id} 的 authority 必须是 OBSERVED`,
    );
    assert(
      ev.source !== undefined,
      `${scenario.name}: evidence ${ev.id} 必须有 source`,
    );
    assert(
      ev.confidence === 1.0,
      `${scenario.name}: OBSERVED evidence ${ev.id} 的 confidence 必须是 1.0`,
    );
  }
}

// ============================================================
// 测试：Authority 不变量
// ============================================================

console.log("\n=== Test Suite: Authority Invariants ===");

// OBSERVED evidence 必须有 source
{
  const obs = makeObservation("obs-inv-1", "chain-inv-1");
  const interp = makeInterpretation("interp-inv-1", "obs-inv-1", "chain-inv-1");
  const result = extractAuthorizedObservations([obs, interp] as any);
  assert(result.length === 1, "OBSERVED evidence 应该被提取");
  assert(result[0].source !== undefined, "OBSERVED evidence 必须有 source");
  assert(result[0].source?.providerId === "sca.observation", "OBSERVED evidence 的 providerId 必须是 sca.observation");
}

// 未授权的 observation 不会出现在结果中（静默过滤，不抛出）
{
  const obs = makeObservation("obs-silent-1", "chain-silent-1", "hub");
  const interp = makeInterpretation("interp-silent-1", "obs-silent-1", "chain-silent-1");
  let threw = false;
  try {
    extractAuthorizedObservations([obs, interp] as any);
  } catch {
    threw = true;
  }
  assert(threw === false, "未授权的 observation 应该被静默过滤，不抛出异常");
}

// ============================================================
// 测试结果汇总
// ============================================================

console.log("\n" + "=".repeat(60));
console.log(`Test Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log("=".repeat(60));

if (failed > 0) {
  console.error("\nFailed tests:");
  failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
  process.exit(1);
} else {
  console.log("\n✓ All Authority Gate contamination tests passed.");
  console.log("  - No observation without interpretation can become OBSERVED");
  console.log("  - No observation with mismatched observationId can become OBSERVED");
  console.log("  - No observation from hub/cloud can become OBSERVED");
  console.log("  - Unauthorized observations are silently filtered (not forged)");
  process.exit(0);
}
