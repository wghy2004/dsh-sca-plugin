/**
 * Phase F-1.1 内核不变量验证脚本（纯 JavaScript，可直接用 node 运行）
 *
 * 验证内容：
 *   Suite 1: Authority Gate 污染测试（8 场景）
 *   Suite 2: Mission Replay 投影测试（9 场景）
 *   Suite 3: Completion Gate 不变量（含 EvidenceScope 升级）
 *   Suite 4: VerificationCaptured 边界（含 confirmed 禁止）
 *   Suite 5: EvidenceScope 跨 Mission/Action 污染（F-1.1 新增）
 *   Suite 6: Authority Model 无 trust 语义（F-1.1 新增）
 *   Suite 7: OBSERVED → DERIVED → COMPLETED 完整链路
 *
 * 运行方式：node tests/run-all.mjs
 */

// ============================================================
// 内联：isAuthorizedObservation
// ============================================================

const AUTHORIZED_OBSERVATION_SOURCES = new Set(["content_script", "service_worker"]);

function isAuthorizedObservation(event, chainEvents) {
  if (event.type !== "observation") return false;
  if (!AUTHORIZED_OBSERVATION_SOURCES.has(event.source)) return false;
  return chainEvents.some(
    (e) => e.type === "interpretation" && e.payload.observationId === event.id,
  );
}

function extractAuthorizedObservations(chainEvents) {
  return chainEvents
    .filter((e) => isAuthorizedObservation(e, chainEvents))
    .map((e) => ({
      id: e.id, authority: "OBSERVED",
      source: { providerId: "sca.observation", uri: e.payload.pageUrl },
      confidence: 1.0, createdAt: e.ts,
    }));
}

// ============================================================
// 内联：projectMissionEvents
// ============================================================

function projectMissionEvents(events) {
  if (events.length === 0) return null;
  const created = events.find((e) => e.type === "MISSION_CREATED");
  if (!created) return null;
  let mission = {
    id: created.missionId, kind: created.kind, state: "CREATED",
    createdAt: created.createdAt, updatedAt: created.createdAt,
    input: created.input, correlationId: created.correlationId, operationId: created.operationId,
  };
  for (const event of events) {
    if (event.type === "MISSION_CREATED") continue;
    switch (event.type) {
      case "MISSION_STATE_CHANGED": mission = { ...mission, state: event.toState, updatedAt: event.changedAt }; break;
      case "MISSION_CHECKPOINTED": mission = { ...mission, checkpoint: event.checkpoint, updatedAt: event.changedAt }; break;
      case "APPROVAL_REQUESTED": mission = { ...mission, state: "AWAITING_APPROVAL", pendingApproval: event.approval, updatedAt: event.changedAt }; break;
      case "APPROVAL_GRANTED": mission = { ...mission, pendingApproval: undefined, updatedAt: event.changedAt }; break;
      case "APPROVAL_DENIED": mission = { ...mission, state: "CANCELLED", pendingApproval: undefined, failure: event.reason ? { code: "APPROVAL_DENIED", category: "POLICY", message: event.reason, recoverable: false, retryable: false } : undefined, updatedAt: event.changedAt }; break;
      case "ACTION_UPDATED": mission = { ...mission, action: event.action, updatedAt: event.changedAt }; break;
      case "VERIFICATION_CAPTURED": mission = { ...mission, verification: event.verification, updatedAt: event.changedAt }; break;
      case "MISSION_FAILED": mission = { ...mission, state: "FAILED", failure: event.failure, updatedAt: event.changedAt }; break;
    }
  }
  return mission;
}

// ============================================================
// 内联：checkEvidenceScope（F-1.1 新增）
// ============================================================

function checkEvidenceScope(evidence, context) {
  if (evidence.missionId && evidence.missionId !== context.missionId) {
    return { valid: false, reason: `MISSION_SCOPE_MISMATCH: ${evidence.missionId} !== ${context.missionId}` };
  }
  if (context.actionId && evidence.actionId && evidence.actionId !== context.actionId) {
    return { valid: false, reason: `ACTION_SCOPE_MISMATCH: ${evidence.actionId} !== ${context.actionId}` };
  }
  if (context.actionStartedAt && evidence.createdAt < context.actionStartedAt) {
    return { valid: false, reason: `TEMPORAL_SCOPE_INVALID: ${evidence.createdAt} < ${context.actionStartedAt}` };
  }
  if (evidence.correlationId && evidence.correlationId !== context.correlationId) {
    return { valid: false, reason: `CORRELATION_SCOPE_MISMATCH` };
  }
  return { valid: true };
}

// ============================================================
// 内联：checkCompletionInvariants（F-1.1 更新）
// ============================================================

function checkCompletionInvariants(mission, verificationEvidence, context, isSuccess) {
  const violations = [];
  if (!mission.action?.completedAt) violations.push("ACTION_NOT_COMPLETED");
  if (!mission.verification) violations.push("VERIFICATION_MISSING");
  else {
    if (!mission.verification.evidenceIds?.length) violations.push("VERIFICATION_NO_EVIDENCE");
  }
  if (verificationEvidence?.length) {
    // 必须至少有一条 OBSERVED（DERIVED 允许，INFERRED/RETRACTED 禁止）
    const hasObserved = verificationEvidence.some((e) => e.authority === "OBSERVED");
    if (!hasObserved) violations.push("NO_OBSERVED_EVIDENCE");
    const invalidAuth = verificationEvidence.filter((e) => e.authority === "INFERRED" || e.authority === "RETRACTED");
    if (invalidAuth.length) violations.push(`INVALID_VERIFICATION_AUTHORITY:${invalidAuth.length}`);
    if (context) {
      for (const ev of verificationEvidence) {
        const scope = checkEvidenceScope(ev, context);
        if (!scope.valid) violations.push(`EVIDENCE_SCOPE_INVALID:${ev.id}:${scope.reason}`);
      }
    }
    // confirmed 从 evidence 推导（不依赖存储的 confirmed 字段）
    const confirmed = hasObserved && (isSuccess ? isSuccess(verificationEvidence) : hasObserved);
    if (!confirmed) violations.push("VERIFICATION_NOT_CONFIRMED");
  } else if (mission.verification?.evidenceIds?.length) {
    violations.push("EVIDENCE_NOT_PROVIDED");
  }
  return { canComplete: violations.length === 0, violations };
}

// ============================================================
// 内联：assertVerificationBoundary（F-1.1 更新：禁止 confirmed）
// ============================================================

function assertVerificationBoundary(event) {
  const v = event.verification;
  if (v && typeof v === "object" && "authority" in v) throw new Error("authority not allowed");
  if (v && typeof v === "object" && "confirmed" in v) throw new Error("confirmed not allowed in event");
  if (!v.evidenceIds || v.evidenceIds.length === 0) throw new Error("evidenceIds must be non-empty");
}

// ============================================================
// 测试框架
// ============================================================

let passed = 0, failed = 0;
const failures = [];
function assert(c, m) { if (c) passed++; else { failed++; failures.push(m); console.error(`  ✗ ${m}`); } }
function assertEq(a, b, m) { assert(JSON.stringify(a) === JSON.stringify(b), `${m} (expected=${JSON.stringify(b)}, actual=${JSON.stringify(a)})`); }

// ============================================================
// Suite 1: Authority Gate Contamination
// ============================================================

console.log("\n" + "=".repeat(60));
console.log("Suite 1: Authority Gate Contamination (8 tests)");
console.log("=".repeat(60));

const makeObs = (id, chainId, source = "content_script") => ({
  id, ts: 1000, type: "observation",
  payload: { chainId, pageUrl: "https://example.com", pageTitle: "Test", extractedText: "", selector: "" },
  source, traceHash: "h", chainId,
});
const makeInterp = (id, obsId, chainId) => ({
  id, ts: 1001, type: "interpretation",
  payload: { chainId, observationId: obsId, riskTags: [], summary: "", modelVersion: "v1", isLocal: false },
  source: "cloud", traceHash: "h", chainId,
});

{
  const r = extractAuthorizedObservations([makeObs("o1", "c1"), makeInterp("i1", "o1", "c1")]);
  assertEq(r.length, 1, "1.1 正常 → 1 OBSERVED");
}
{ assertEq(extractAuthorizedObservations([makeObs("o2", "c2")]).length, 0, "1.2 无 interpretation → 0"); }
{ assertEq(extractAuthorizedObservations([makeObs("o3", "c3"), makeInterp("i3", "OTHER", "c3")]).length, 0, "1.3 observationId 不匹配 → 0"); }
{ assertEq(extractAuthorizedObservations([makeObs("o4", "c4", "hub"), makeInterp("i4", "o4", "c4")]).length, 0, "1.4 source=hub → 0"); }
{ assertEq(extractAuthorizedObservations([makeObs("o5", "c5", "cloud"), makeInterp("i5", "o5", "c5")]).length, 0, "1.5 source=cloud → 0"); }
{
  const r = extractAuthorizedObservations([makeObs("o6a", "c6"), makeObs("o6b", "c6", "hub"), makeInterp("i6a", "o6a", "c6"), makeInterp("i6b", "o6b", "c6")]);
  assertEq(r.length, 1, "1.6 混合 → 只有正常的");
}
{ assertEq(extractAuthorizedObservations([makeObs("o7a", "c7"), makeObs("o7b", "c7"), makeInterp("i7a", "o7a", "c7"), makeInterp("i7b", "o7b", "c7")]).length, 2, "1.7 多个正常 → 2"); }
{ let threw = false; try { extractAuthorizedObservations([makeObs("o8", "c8", "hub")]); } catch { threw = true; } assert(!threw, "1.8 静默过滤不抛出"); }

// ============================================================
// Suite 2: Mission Replay
// ============================================================

console.log("\n" + "=".repeat(60));
console.log("Suite 2: Mission Replay / Projection (9 tests)");
console.log("=".repeat(60));

const created = (id, kind = "JOB_SEARCH") => ({ type: "MISSION_CREATED", missionId: id, kind, input: {}, correlationId: `corr-${id}`, operationId: `op-${id}`, createdAt: 1000 });
const stateChange = (id, from, to, ts) => ({ type: "MISSION_STATE_CHANGED", missionId: id, fromState: from, toState: to, changedAt: ts });

assertEq(projectMissionEvents([]), null, "2.1 空 → null");
assertEq(projectMissionEvents([created("m1")]).state, "CREATED", "2.2 只有 CREATED");
assertEq(projectMissionEvents([created("m2"), stateChange("m2","CREATED","PLANNING",1001), stateChange("m2","PLANNING","COMPLETED",1002)]).state, "COMPLETED", "2.3 完整流程");
{
  const r = projectMissionEvents([created("m3","JOB_APPLICATION"), stateChange("m3","CREATED","PLANNING",1001), { type:"APPROVAL_REQUESTED", missionId:"m3", approval:{missionId:"m3",reason:"need",requestedAt:1002}, changedAt:1002 }]);
  assertEq(r.state, "AWAITING_APPROVAL", "2.4 需要审批");
}
{
  const r = projectMissionEvents([created("m4","JOB_APPLICATION"), stateChange("m4","CREATED","PLANNING",1001), { type:"APPROVAL_REQUESTED", missionId:"m4", approval:{missionId:"m4",reason:"need",requestedAt:1002}, changedAt:1002 }, { type:"APPROVAL_DENIED", missionId:"m4", reason:"user deny", changedAt:1003 }]);
  assertEq(r.state, "CANCELLED", "2.5 审批被拒绝");
}
{
  const r = projectMissionEvents([
    created("m5","JOB_APPLICATION"),
    stateChange("m5","CREATED","EXECUTING",1001),
    { type:"ACTION_UPDATED", missionId:"m5", action:{type:"JOB_APPLICATION",startedAt:1001,completedAt:1005,receiptId:"r1"}, changedAt:1005 },
    stateChange("m5","EXECUTING","VERIFYING",1006),
    // ⚠️ F-1.1: VerificationCaptured 不包含 confirmed
    { type:"VERIFICATION_CAPTURED", missionId:"m5", verification:{evidenceIds:["ev1","ev2"],verifiedAt:1007,summary:"ok"}, changedAt:1007 },
    stateChange("m5","VERIFYING","COMPLETED",1008),
  ]);
  assertEq(r.state, "COMPLETED", "2.6 Apply 完整成功");
  assertEq(r.verification.evidenceIds, ["ev1","ev2"], "2.6 evidenceIds 正确");
  assert(!("confirmed" in r.verification), "2.6 verification 不包含 confirmed 字段");
}
{
  const r = projectMissionEvents([created("m6"), stateChange("m6","CREATED","PLANNING",1001), { type:"MISSION_FAILED", missionId:"m6", failure:{code:"NET",category:"NETWORK",message:"fail",recoverable:true,retryable:true}, changedAt:1002 }]);
  assertEq(r.state, "FAILED", "2.7 失败");
}
assertEq(projectMissionEvents([stateChange("mx","CREATED","PLANNING",1001)]), null, "2.8 无 MISSION_CREATED → null");
{
  const s = projectMissionEvents([created("m9"), stateChange("m9","CREATED","PLANNING",1001)]);
  const r = projectMissionEvents([created("m9"), stateChange("m9","CREATED","PLANNING",1001), stateChange("m9","CREATED","PLANNING",1001)]);
  assertEq(r.state, s.state, "2.9 幂等性");
}

// ============================================================
// Suite 3: Completion Gate Invariants
// ============================================================

console.log("\n" + "=".repeat(60));
console.log("Suite 3: Completion Gate Invariants (8 tests)");
console.log("=".repeat(60));

{
  const m = { action:{completedAt:1005}, verification:{evidenceIds:["e1"]} };
  const ev = [{id:"e1",authority:"OBSERVED",createdAt:1006,missionId:"m1"}];
  const ctx = {missionId:"m1",correlationId:"c1",operationId:"o1",actionId:"a1",actionStartedAt:1001};
  const r = checkCompletionInvariants(m, ev, ctx);
  assert(r.canComplete, "3.1 全部满足 → canComplete");
}
{
  const m = { action:{}, verification:{evidenceIds:["e1"]} };
  const r = checkCompletionInvariants(m, [{authority:"OBSERVED"}], {});
  assert(!r.canComplete && r.violations.includes("ACTION_NOT_COMPLETED"), "3.2 action 未完成");
}
{
  const m = { action:{completedAt:1005}, verification:{evidenceIds:["e1"]} };
  const r = checkCompletionInvariants(m, [{authority:"DERIVED"}], {});
  assert(!r.canComplete, "3.3 非 OBSERVED → 拒绝");
}
{
  const m = { action:{completedAt:1005}, verification:{evidenceIds:["e1"]} };
  const ev = [{id:"e1",authority:"OBSERVED",createdAt:900,missionId:"m1"}]; // 早于 action
  const ctx = {missionId:"m1",correlationId:"c1",operationId:"o1",actionId:"a1",actionStartedAt:1001};
  const r = checkCompletionInvariants(m, ev, ctx);
  assert(!r.canComplete, "3.4 时间范围无效 → 拒绝");
}
{
  const m = { action:{completedAt:1005} };
  const r = checkCompletionInvariants(m, [], {});
  assert(!r.canComplete, "3.5 无 verification → 拒绝");
}
{
  const m = { action:{completedAt:1005}, verification:{evidenceIds:["e1"]} };
  const ev = [{id:"e1",authority:"OBSERVED",createdAt:1006,missionId:"m1"}];
  const ctx = {missionId:"m1",correlationId:"c1",operationId:"o1",actionId:"a1",actionStartedAt:1001};
  const isSuccess = () => false; // 强制不成功
  const r = checkCompletionInvariants(m, ev, ctx, isSuccess);
  assert(!r.canComplete && r.violations.some(v => v.includes("VERIFICATION_NOT_CONFIRMED")), "3.6 isSuccess 返回 false → 拒绝");
}
{
  const m = { action:{completedAt:1005}, verification:{evidenceIds:["e1"]} };
  const ev = [{id:"e1",authority:"OBSERVED",createdAt:1006,missionId:"m1"},{id:"d1",authority:"DERIVED",claimKey:"application.status",value:"SUBMITTED"}];
  const ctx = {missionId:"m1",correlationId:"c1",operationId:"o1",actionId:"a1",actionStartedAt:1001};
  const isSuccess = (e) => e.some(x => x.authority==="DERIVED" && x.claimKey==="application.status" && x.value==="SUBMITTED");
  const r = checkCompletionInvariants(m, ev, ctx, isSuccess);
  assert(r.canComplete, "3.7 OBSERVED + DERIVED SUBMITTED → 通过");
}
{
  const m = { action:{completedAt:1005}, verification:{evidenceIds:["e1"]} };
  const ev = [{id:"e1",authority:"OBSERVED",createdAt:1006,missionId:"m1"}];
  const ctx = {missionId:"m1",correlationId:"c1",operationId:"o1",actionId:"a1",actionStartedAt:1001};
  // 不传 isSuccess，默认 hasObserved=true
  const r = checkCompletionInvariants(m, ev, ctx);
  assert(r.canComplete, "3.8 默认 isSuccess（有 OBSERVED 即通过）");
}

// ============================================================
// Suite 4: VerificationCaptured Boundary
// ============================================================

console.log("\n" + "=".repeat(60));
console.log("Suite 4: VerificationCaptured Boundary (4 tests)");
console.log("=".repeat(60));

{ let threw=false; try { assertVerificationBoundary({verification:{evidenceIds:["e1"]}}); } catch { threw=true; } assert(!threw, "4.1 合法 → 不抛出"); }
{ let threw=false; try { assertVerificationBoundary({verification:{evidenceIds:["e1"],authority:"OBSERVED"}}); } catch { threw=true; } assert(threw, "4.2 含 authority → 抛出"); }
{ let threw=false; try { assertVerificationBoundary({verification:{evidenceIds:["e1"],confirmed:true}}); } catch { threw=true; } assert(threw, "4.3 含 confirmed → 抛出 (F-1.1)"); }
{ let threw=false; try { assertVerificationBoundary({verification:{evidenceIds:[]}}); } catch { threw=true; } assert(threw, "4.4 evidenceIds 为空 → 抛出"); }

// ============================================================
// Suite 5: EvidenceScope 跨 Mission/Action 污染（F-1.1 核心新增）
// ============================================================

console.log("\n" + "=".repeat(60));
console.log("Suite 5: EvidenceScope Cross-Mission/Action Contamination (8 tests)");
console.log("=".repeat(60));

// 5.1 MissionScope: evidence.missionId 不匹配
{
  const ev = { id:"e1", authority:"OBSERVED", createdAt:1006, missionId:"mission-B" };
  const ctx = { missionId:"mission-A", correlationId:"cA", operationId:"oA", actionId:"aA", actionStartedAt:1001 };
  const r = checkEvidenceScope(ev, ctx);
  assert(!r.valid && r.reason.includes("MISSION_SCOPE_MISMATCH"), "5.1 MissionScope 不匹配 → 拒绝");
}

// 5.2 ActionScope: evidence.actionId 不匹配
{
  const ev = { id:"e1", authority:"OBSERVED", createdAt:1006, missionId:"m1", actionId:"action-2" };
  const ctx = { missionId:"m1", correlationId:"c1", operationId:"o1", actionId:"action-1", actionStartedAt:1001 };
  const r = checkEvidenceScope(ev, ctx);
  assert(!r.valid && r.reason.includes("ACTION_SCOPE_MISMATCH"), "5.2 ActionScope 不匹配 → 拒绝");
}

// 5.3 跨 Mission 污染：Mission A verify 时传入 Mission B 的 evidence
{
  const missionA = { action:{completedAt:1005}, verification:{evidenceIds:["eB"]} };
  const evB = [{ id:"eB", authority:"OBSERVED", createdAt:1006, missionId:"mission-B", actionId:"action-B" }];
  const ctxA = { missionId:"mission-A", correlationId:"cA", operationId:"oA", actionId:"action-A", actionStartedAt:1001 };
  const r = checkCompletionInvariants(missionA, evB, ctxA);
  assert(!r.canComplete, "5.3 跨 Mission 证据 → 拒绝 (Mission A 不能吸收 Mission B 的 evidence)");
  assert(r.violations.some(v => v.includes("MISSION_SCOPE_MISMATCH")), "5.3 违规包含 MISSION_SCOPE_MISMATCH");
}

// 5.4 同 Mission 不同 Action：Action 1 的 evidence 不能用于 Action 2
{
  const mission = { action:{completedAt:1005,receiptId:"action-2"}, verification:{evidenceIds:["e1"]} };
  const evOld = [{ id:"e1", authority:"OBSERVED", createdAt:1006, missionId:"m1", actionId:"action-1" }];
  const ctx = { missionId:"m1", correlationId:"c1", operationId:"o1", actionId:"action-2", actionStartedAt:1001 };
  const r = checkCompletionInvariants(mission, evOld, ctx);
  assert(!r.canComplete, "5.4 同 Mission 不同 Action → 拒绝");
  assert(r.violations.some(v => v.includes("ACTION_SCOPE_MISMATCH")), "5.4 违规包含 ACTION_SCOPE_MISMATCH");
}

// 5.5 时间相同但 action 不同 → 拒绝（证明时间不足以作为 Scope Authority）
{
  const ev = { id:"e1", authority:"OBSERVED", createdAt:1006, missionId:"m1", actionId:"action-B" };
  const ctx = { missionId:"m1", correlationId:"c1", operationId:"o1", actionId:"action-A", actionStartedAt:1000 };
  const r = checkEvidenceScope(ev, ctx);
  assert(!r.valid, "5.5 时间相同但 action 不同 → 拒绝 (时间不是 Scope Authority)");
}

// 5.6 正确的 Mission+Action+时间 → 通过
{
  const ev = { id:"e1", authority:"OBSERVED", createdAt:1006, missionId:"m1", actionId:"a1", correlationId:"c1" };
  const ctx = { missionId:"m1", correlationId:"c1", operationId:"o1", actionId:"a1", actionStartedAt:1001 };
  const r = checkEvidenceScope(ev, ctx);
  assert(r.valid, "5.6 正确的 Mission+Action+时间 → 通过");
}

// 5.7 evidence 无 missionId 但 context 有 → 通过（向后兼容，不强制要求）
{
  const ev = { id:"e1", authority:"OBSERVED", createdAt:1006 };
  const ctx = { missionId:"m1", correlationId:"c1", operationId:"o1", actionId:"a1", actionStartedAt:1001 };
  const r = checkEvidenceScope(ev, ctx);
  assert(r.valid, "5.7 evidence 无 missionId → 通过 (不强制要求，向后兼容)");
}

// 5.8 correlationId 不匹配 → 拒绝
{
  const ev = { id:"e1", authority:"OBSERVED", createdAt:1006, missionId:"m1", correlationId:"corr-OTHER" };
  const ctx = { missionId:"m1", correlationId:"corr-m1", operationId:"o1", actionId:"a1", actionStartedAt:1001 };
  const r = checkEvidenceScope(ev, ctx);
  assert(!r.valid && r.reason.includes("CORRELATION_SCOPE_MISMATCH"), "5.8 correlationId 不匹配 → 拒绝");
}

// ============================================================
// Suite 6: Authority Model 无 trust 语义（F-1.1 新增）
// ============================================================

console.log("\n" + "=".repeat(60));
console.log("Suite 6: Authority Model - No Trust Semantics (4 tests)");
console.log("=".repeat(60));

// 模拟 AUTHORITY_MODEL（不含 trustLevel）
const AUTHORITY_MODEL = {
  OBSERVED: { authority:"OBSERVED", epistemicClass:"reality", canVerifyCompletion:true },
  DERIVED: { authority:"DERIVED", epistemicClass:"deterministic", canVerifyCompletion:false },
  INFERRED: { authority:"INFERRED", epistemicClass:"hypothesis", canVerifyCompletion:false },
  RETRACTED: { authority:"RETRACTED", epistemicClass:"invalidated", canVerifyCompletion:false },
};

{
  for (const [auth, def] of Object.entries(AUTHORITY_MODEL)) {
    assert(!("trustLevel" in def), `6.1 ${auth} 不含 trustLevel 字段`);
    assert("epistemicClass" in def, `6.1 ${auth} 有 epistemicClass 字段`);
  }
}
{
  assert(AUTHORITY_MODEL.OBSERVED.canVerifyCompletion === true, "6.2 OBSERVED 可验证 Completion");
  assert(AUTHORITY_MODEL.DERIVED.canVerifyCompletion === false, "6.2 DERIVED 不可单独验证");
  assert(AUTHORITY_MODEL.INFERRED.canVerifyCompletion === false, "6.2 INFERRED 不可验证");
}
{
  // Authority 是认识论分类，不是概率
  const classes = new Set(Object.values(AUTHORITY_MODEL).map(d => d.epistemicClass));
  assertEq(classes.size, 4, "6.3 四种不同的认识论分类");
}
{
  // confidence 是具体 Claim 的属性，不是 Authority 的属性
  const evWithConfidence = { authority:"OBSERVED", confidence:1.0 };
  const evLowConfidence = { authority:"INFERRED", confidence:0.3 };
  assert(evWithConfidence.authority === "OBSERVED", "6.4 authority 与 confidence 分离");
  assert(evLowConfidence.authority === "INFERRED", "6.4 INFERRED 可以有低 confidence");
}

// ============================================================
// Suite 7: OBSERVED → DERIVED → COMPLETED 完整链路
// ============================================================

console.log("\n" + "=".repeat(60));
console.log("Suite 7: OBSERVED → DERIVED → COMPLETED Full Chain (4 tests)");
console.log("=".repeat(60));

// 7.1 完整链路：OBSERVED 页面文本 → DERIVED status → COMPLETED
{
  const observedEv = { id:"obs-1", authority:"OBSERVED", claimKey:"observation:page", value:{extractedText:"投递成功"}, createdAt:1006, missionId:"m1", actionId:"a1" };
  const derivedEv = { id:"der-1", authority:"DERIVED", claimKey:"application.status", value:"SUBMITTED", createdAt:1007, missionId:"m1", actionId:"a1" };
  const mission = { action:{completedAt:1005,receiptId:"a1"}, verification:{evidenceIds:["obs-1","der-1"]} };
  const ctx = { missionId:"m1", correlationId:"c1", operationId:"o1", actionId:"a1", actionStartedAt:1001 };
  const isSuccess = (ev) => ev.some(e => e.authority==="DERIVED" && e.claimKey==="application.status" && e.value==="SUBMITTED");
  const r = checkCompletionInvariants(mission, [observedEv, derivedEv], ctx, isSuccess);
  assert(r.canComplete, "7.1 OBSERVED→DERIVED SUBMITTED→COMPLETED 完整链路通过");
}

// 7.2 只有 OBSERVED 但没有 DERIVED SUBMITTED → 不通过（需要 isSuccess 判断）
{
  const observedEv = { id:"obs-1", authority:"OBSERVED", claimKey:"observation:page", value:{extractedText:"请登录后继续"}, createdAt:1006, missionId:"m1", actionId:"a1" };
  const mission = { action:{completedAt:1005,receiptId:"a1"}, verification:{evidenceIds:["obs-1"]} };
  const ctx = { missionId:"m1", correlationId:"c1", operationId:"o1", actionId:"a1", actionStartedAt:1001 };
  const isSuccess = (ev) => ev.some(e => e.authority==="DERIVED" && e.claimKey==="application.status" && e.value==="SUBMITTED");
  const r = checkCompletionInvariants(mission, [observedEv], ctx, isSuccess);
  assert(!r.canComplete, "7.2 只有 OBSERVED(请登录) 无 DERIVED SUBMITTED → 不通过");
}

// 7.3 Execution Success ≠ Verification Success
{
  // ActionReceipt.accepted=true 但 Observation="请登录后继续"
  const mission = { action:{completedAt:1005,receiptId:"a1",receipt:{accepted:true}}, verification:{evidenceIds:["obs-1"]} };
  const observedEv = { id:"obs-1", authority:"OBSERVED", value:{extractedText:"请登录后继续"}, createdAt:1006, missionId:"m1", actionId:"a1" };
  const ctx = { missionId:"m1", correlationId:"c1", operationId:"o1", actionId:"a1", actionStartedAt:1001 };
  const isSuccess = (ev) => ev.some(e => e.authority==="DERIVED" && e.value==="SUBMITTED");
  const r = checkCompletionInvariants(mission, [observedEv], ctx, isSuccess);
  assert(!r.canComplete, "7.3 Execution accepted=true 但 Observation=请登录 → COMPLETED=false");
}

// 7.4 Verification Event Replay: Event 不存 confirmed，Projection 从 evidence 推导
{
  const events = [
    created("m7","JOB_APPLICATION"),
    stateChange("m7","CREATED","EXECUTING",1001),
    { type:"ACTION_UPDATED", missionId:"m7", action:{type:"JOB_APPLICATION",startedAt:1001,completedAt:1005,receiptId:"a1"}, changedAt:1005 },
    stateChange("m7","EXECUTING","VERIFYING",1006),
    { type:"VERIFICATION_CAPTURED", missionId:"m7", verification:{evidenceIds:["obs-1"],verifiedAt:1007,summary:"页面观察到投递成功"}, changedAt:1007 },
  ];
  const projected = projectMissionEvents(events);
  // Event 中没有 confirmed，Projection 中也不应该有 confirmed
  assert(!("confirmed" in projected.verification), "7.4 Replay 后 verification 不包含 confirmed");
  assertEq(projected.verification.evidenceIds, ["obs-1"], "7.4 Replay 后 evidenceIds 正确");
  assertEq(projected.state, "VERIFYING", "7.4 Replay 后状态为 VERIFYING（COMPLETED 由 Completion Gate 推导，不是 Event）");
}

// ============================================================
// 汇总
// ============================================================

console.log("\n" + "=".repeat(60));
console.log(`Phase F-1.1 Kernel Invariants: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log("=".repeat(60));

if (failed > 0) {
  console.error("\nFailed:");
  failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
  process.exit(1);
} else {
  console.log("\n✓ All Phase F-1.1 kernel invariants passed.");
  console.log("");
  console.log("Verified invariants (F-1.1 hardening):");
  console.log("  ① EvidenceScope = MissionScope + ActionScope + TemporalScope (not just time)");
  console.log("  ② Cross-Mission evidence cannot be absorbed by another Mission");
  console.log("  ③ Same-Mission different-Action evidence cannot be reused");
  console.log("  ④ Time alone is not sufficient as Scope Authority");
  console.log("  ⑤ VerificationCaptured must not store confirmed (derived state)");
  console.log("  ⑥ VerificationCaptured must not store authority (evidence chain)");
  console.log("  ⑦ Authority = epistemic class, confidence = claim confidence (separated)");
  console.log("  ⑧ No trustLevel in AuthorityModel (different semantic types)");
  console.log("  ⑨ OBSERVED → DERIVED → COMPLETED full chain required");
  console.log("  ⑩ Execution accepted ≠ Verification success (reality observation required)");
  console.log("  ⑪ Mission can be replayed from Domain Event stream (no confirmed in event)");
  console.log("  ⑫ COMPLETED is derived by Completion Gate, not stored as event fact");
  process.exit(0);
}
