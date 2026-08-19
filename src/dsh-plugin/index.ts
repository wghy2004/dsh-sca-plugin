import type {
  ApplyRequest,
  JobInspectRequest,
  JobSearchRequest,
} from "./contract/types";

import {
  DefaultPolicyEngine,
} from "./contract/policy";

import type {
  MissionRepository,
} from "./contract/mission";

import {
  EvidenceFactory,
} from "./contract/evidence";

import {
  CareerService,
  type CareerServiceDependencies,
} from "./services/career-service";

import {
  MissionService,
} from "./services/mission-service";

import {
  SCACareerStateAdapter,
  SCARuntimeProvider,
  type ExistingSCARuntime,
} from "./adapter/sca-runtime-adapter";

import {
  SCAMissionRepository,
} from "./runtime";

import {
  SCA_DSH_PLUGIN_MANIFEST,
} from "./manifest";

/**
 * SCA DSH Plugin
 *
 * 这是唯一应该被 DSH Runtime 挂载的入口。
 *
 * 定位：
 *   DSH = Cognition / Intent / Mission Orchestration
 *   SCA = State / Policy / Reality Interaction / Evidence
 *   本 Plugin = 二者之间的 Capability Seam
 *
 * ⚠️ Phase F-0: 生产环境必须使用 SCAMissionRepository（Event Sourcing）。
 *   Mission 状态是 Event Store 的投影，不是独立变量。
 *   InMemoryMissionRepository 仅用于 unit test，不通过此构造函数注入。
 */
export class SCADSHPlugin {
  readonly manifest =
    SCA_DSH_PLUGIN_MANIFEST;

  readonly career: CareerService;
  readonly mission: MissionService;

  constructor(
    runtime: ExistingSCARuntime,
    options?: {
      /**
       * 自定义 MissionRepository。
       * 生产环境留空，默认使用 SCAMissionRepository。
       * 仅在 unit test 中传入 InMemoryMissionRepository。
       */
      missionRepository?: MissionRepository;
    },
  ) {
    const dependencies:
      CareerServiceDependencies = {
        careerState:
          new SCACareerStateAdapter(runtime),

        provider:
          new SCARuntimeProvider(runtime),

        // Phase F-0: 生产默认使用 Event Sourcing Repository
        missionRepository:
          options?.missionRepository ?? new SCAMissionRepository(),

        policyEngine:
          new DefaultPolicyEngine(),

        evidenceFactory:
          new EvidenceFactory(),
      };

    this.career =
      new CareerService(dependencies);

    this.mission =
      new MissionService(
        this.career,
      );
  }

  /**
   * DSH Capability: search
   * 只读能力，不需要审批。
   */
  async search(
    request: JobSearchRequest,
  ) {
    return this.career.search(request);
  }

  /**
   * DSH Capability: inspect
   * 只读能力，不需要审批。
   */
  async inspect(
    request: JobInspectRequest,
  ) {
    return this.career.inspect(request);
  }

  /**
   * DSH Capability: apply
   * 外部副作用能力，必须经过 Policy + Approval + Verify。
   *
   * 可能返回：
   *   - state: COMPLETED（有 OBSERVED verification evidence）
   *   - state: AWAITING_APPROVAL（需要调用 missionApprove）
   *   - state: FAILED（policy deny / preparation blocked / execution failed / verification failed）
   */
  async apply(
    request: ApplyRequest,
  ) {
    return this.career.apply(request);
  }

  /**
   * DSH Runtime Mission Control
   */
  async missionStatus(
    missionId: string,
  ) {
    return this.mission.status(missionId);
  }

  async missionPause(
    missionId: string,
  ) {
    return this.mission.pause(missionId);
  }

  async missionCancel(
    missionId: string,
  ) {
    return this.mission.cancel(missionId);
  }

  /**
   * 批准处于 AWAITING_APPROVAL 状态的投递 Mission。
   * 批准后继续执行 EXECUTING → VERIFYING → COMPLETED/FAILED。
   */
  async missionApprove(
    missionId: string,
    approvalToken?: string,
  ) {
    return this.mission.approve(missionId, approvalToken);
  }

  /**
   * 拒绝处于 AWAITING_APPROVAL 状态的投递 Mission。
   * 拒绝后进入 CANCELLED。
   */
  async missionDeny(
    missionId: string,
    reason?: string,
  ) {
    return this.mission.deny(missionId, reason);
  }
}

export * from "./manifest";
export * from "./contract/types";
export * from "./contract/evidence";
export * from "./contract/policy";
export * from "./contract/mission";
export * from "./contract/mission-events";
export * from "./contract/mission-completion";
export * from "./contract/authority-model";
export * from "./providers/types";
export * from "./providers/sca-provider";
export * from "./services/career-service";
export * from "./services/mission-service";
export * from "./adapter/sca-runtime-adapter";
export * from "./runtime";
