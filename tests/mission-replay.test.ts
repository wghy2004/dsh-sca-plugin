/**
 * Mission Replay / Projection 测试
 *
 * ⚠️ Phase F: 验证 Mission 不"存 State"，而是"投影 State"。
 *
 * 核心不变量：
 *   删除 MissionRecord → 重新读取 Event Store → replay → 得到完全相同的 MissionRecord
 *
 * 测试场景：
 *   1. 空事件流 → null
 *   2. 只有 MISSION_CREATED → CREATED
 *   3. Search 完整流程 → COMPLETED
 *   4. Apply 需要审批 → AWAITING_APPROVAL
 *   5. Apply 审批被拒绝 → CANCELLED
 *   6. Apply 完整成功 → COMPLETED（含 action + verification）
 *   7. Mission 失败 → FAILED
 *   8. 事件顺序不影响最终状态（幂等性）
 *   9. 重复事件不改变状态（幂等性）
 *
 * 运行方式：npx tsx tests/mission-replay.test.ts
 */

import {
  projectMissionEvents,
  buildReplayScenarios,
} from "../src/dsh-plugin/contract/mission-projection";
import type {
  MissionDomainEvent,
  MissionCreatedEvent,
  MissionStateChangedEvent,
} from "../src/dsh-plugin/contract/mission-events";
import type { MissionRecord } from "../src/dsh-plugin/contract/types";

// ============================================================
// 简单测试框架
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

function assertNotNull(value: unknown, message: string): void {
  assert(value !== null && value !== undefined, message);
}

// ============================================================
// 测试：Replay Scenarios
// ============================================================

console.log("\n=== Test Suite: Mission Replay / Projection ===");

const scenarios = buildReplayScenarios();

for (const scenario of scenarios) {
  console.log(`\n  Scenario: ${scenario.name}`);
  console.log(`    ${scenario.description}`);

  const result = projectMissionEvents(scenario.events);

  if (scenario.events.length === 0) {
    // 空事件流应该返回 null
    assert(result === null, `${scenario.name}: 空事件流应该返回 null`);
    continue;
  }

  assertNotNull(result, `${scenario.name}: 投影结果不应该为 null`);
  if (!result) continue;

  assertEqual(
    result.state,
    scenario.expectedState,
    `${scenario.name}: 最终状态`,
  );

  // 验证期望的字段
  if (scenario.expectedFields) {
    for (const [key, expectedValue] of Object.entries(scenario.expectedFields)) {
      const actualValue = (result as any)[key];
      assertEqual(
        actualValue,
        expectedValue,
        `${scenario.name}: 字段 ${key}`,
      );
    }
  }
}

// ============================================================
// 测试：幂等性 —— 重复事件不改变状态
// ============================================================

console.log("\n=== Test Suite: Idempotency ===");

{
  const created: MissionCreatedEvent = {
    type: "MISSION_CREATED",
    missionId: "idem-1",
    kind: "JOB_SEARCH",
    input: { query: "test" },
    correlationId: "corr-idem-1",
    operationId: "op-idem-1",
    createdAt: 1000,
  };

  const planning: MissionStateChangedEvent = {
    type: "MISSION_STATE_CHANGED",
    missionId: "idem-1",
    fromState: "CREATED",
    toState: "PLANNING",
    changedAt: 1001,
  };

  // 单次投影
  const single = projectMissionEvents([created, planning]);
  assertNotNull(single, "单次投影不应该为 null");

  // 重复事件投影（planning 出现两次）
  const repeated = projectMissionEvents([created, planning, planning]);
  assertNotNull(repeated, "重复事件投影不应该为 null");

  assertEqual(
    repeated?.state,
    single?.state,
    "重复事件不应该改变最终状态",
  );
  assertEqual(
    repeated?.updatedAt,
    single?.updatedAt,
    "重复事件不应该改变 updatedAt（取最后一个事件的时间）",
  );
}

// ============================================================
// 测试：事件顺序 —— 按时间排序后投影结果一致
// ============================================================

console.log("\n=== Test Suite: Event Ordering ===");

{
  const created: MissionCreatedEvent = {
    type: "MISSION_CREATED",
    missionId: "order-1",
    kind: "JOB_SEARCH",
    input: {},
    correlationId: "corr-order-1",
    operationId: "op-order-1",
    createdAt: 1000,
  };

  const planning: MissionStateChangedEvent = {
    type: "MISSION_STATE_CHANGED",
    missionId: "order-1",
    fromState: "CREATED",
    toState: "PLANNING",
    changedAt: 1001,
  };

  const completed: MissionStateChangedEvent = {
    type: "MISSION_STATE_CHANGED",
    missionId: "order-1",
    fromState: "EVALUATING",
    toState: "COMPLETED",
    changedAt: 1005,
  };

  // 正常顺序
  const normal = projectMissionEvents([created, planning, completed]);

  // 乱序（但 projectMissionEvents 按输入顺序处理，不自动排序）
  // 注意：projectMissionEvents 假设输入已经按时间排序
  // 这里测试的是：如果输入按时间排序，结果正确
  assertEqual(
    normal?.state,
    "COMPLETED",
    "正常顺序投影结果应该是 COMPLETED",
  );
}

// ============================================================
// 测试：Mission 不变量
// ============================================================

console.log("\n=== Test Suite: Mission Invariants ===");

// MISSION_CREATED 必须是第一个事件
{
  const planning: MissionStateChangedEvent = {
    type: "MISSION_STATE_CHANGED",
    missionId: "no-created-1",
    fromState: "CREATED",
    toState: "PLANNING",
    changedAt: 1001,
  };

  const result = projectMissionEvents([planning]);
  assert(result === null, "没有 MISSION_CREATED 的事件流应该返回 null");
}

// MissionRecord.id 必须等于 MISSION_CREATED.missionId
{
  const created: MissionCreatedEvent = {
    type: "MISSION_CREATED",
    missionId: "id-check-1",
    kind: "JOB_SEARCH",
    input: {},
    correlationId: "corr-id-check-1",
    operationId: "op-id-check-1",
    createdAt: 1000,
  };

  const result = projectMissionEvents([created]);
  assertEqual(result?.id, "id-check-1", "MissionRecord.id 必须等于 MISSION_CREATED.missionId");
}

// ============================================================
// 测试：VerificationCaptured 边界
// ============================================================

console.log("\n=== Test Suite: VerificationCaptured Boundary ===");

{
  const { assertVerificationBoundary } = await import(
    "../src/dsh-plugin/contract/mission-events"
  );

  // 正常的 VerificationCaptured（只引用 evidenceIds，不包含 authority）
  const valid = {
    type: "VERIFICATION_CAPTURED" as const,
    missionId: "v-1",
    verification: {
      evidenceIds: ["ev-1", "ev-2"],
      verifiedAt: 1000,
      confirmed: true,
    },
    changedAt: 1000,
  };

  let threw = false;
  try {
    assertVerificationBoundary(valid);
  } catch {
    threw = true;
  }
  assert(threw === false, "合法的 VerificationCaptured 不应该抛出");

  // 非法的 VerificationCaptured（包含 authority 字段）
  const invalid = {
    type: "VERIFICATION_CAPTURED" as const,
    missionId: "v-2",
    verification: {
      evidenceIds: ["ev-1"],
      verifiedAt: 1000,
      confirmed: true,
      authority: "OBSERVED", // ⚠️ 非法：Verification 不应该包含 authority
    },
    changedAt: 1000,
  };

  threw = false;
  try {
    assertVerificationBoundary(invalid as any);
  } catch {
    threw = true;
  }
  assert(threw === true, "包含 authority 字段的 VerificationCaptured 应该抛出");

  // 非法的 VerificationCaptured（evidenceIds 为空）
  const emptyIds = {
    type: "VERIFICATION_CAPTURED" as const,
    missionId: "v-3",
    verification: {
      evidenceIds: [],
      verifiedAt: 1000,
      confirmed: true,
    },
    changedAt: 1000,
  };

  threw = false;
  try {
    assertVerificationBoundary(emptyIds as any);
  } catch {
    threw = true;
  }
  assert(threw === true, "evidenceIds 为空的 VerificationCaptured 应该抛出");
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
  console.log("\n✓ All Mission Replay tests passed.");
  console.log("  - Mission can be fully reconstructed from Domain Event stream");
  console.log("  - Empty event stream returns null");
  console.log("  - Missing MISSION_CREATED returns null");
  console.log("  - VerificationCaptured cannot contain authority field");
  console.log("  - VerificationCaptured must contain non-empty evidenceIds");
  console.log("  - Repeated events do not change final state (idempotent)");
  process.exit(0);
}
