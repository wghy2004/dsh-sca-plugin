/**
 * SCA Runtime 实现层
 *
 * 本目录包含 DSH Plugin 与现有 SCA Core 的真实焊接实现。
 *
 * - sca-core-runtime.ts: ExistingSCARuntime 的完整实现，对接 SCA 的 db / seed-generator / shadow-tab-executor / policy / projection
 * - evidence-mapper.ts: SCA Event → DSH Evidence 的映射，是 OBSERVED Evidence 的唯一合法来源（必须经过 ProvenanceVerifier 校验）
 * - event-sourced-mission-repository.ts: MissionRepository 的 Event Sourcing 实现，Command → Domain Event → Event Store → Projection
 *
 * 使用方式：
 *   import { SCACoreRuntime, SCAMissionRepository } from "./runtime";
 *   const plugin = new SCADSHPlugin(new SCACoreRuntime());
 */

export { SCACoreRuntime } from "./sca-core-runtime";
export { SCAMissionRepository } from "./event-sourced-mission-repository";
export {
  extractEvidenceFromChain,
  mapInteractionStateToJob,
  mapInteractionStatesToJobs,
  extractJobMatchFromChain,
  // ⚠️ P1-2 Fix: mapObservationToEvidence REMOVED — it bypassed Authority Gate.
  // Use extractAuthorizedObservations() instead.
  mapInterpretationToEvidence,
  getEventsByChain,
  getRecentObservations,
  extractAuthorizedObservations,
  isAuthorizedObservation,
} from "./evidence-mapper";
