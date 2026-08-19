#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="$ROOT/src/dsh-plugin"

echo "[SCA-DSH] Initializing plugin architecture..."
echo "[SCA-DSH] Root: $ROOT"
echo "[SCA-DSH] Target: $BASE"

mkdir -p \
  "$BASE/contract" \
  "$BASE/services" \
  "$BASE/providers" \
  "$BASE/adapter"

# ============================================================
# 1. contract/types.ts
# ============================================================

cat > "$BASE/contract/types.ts" <<'EOF'
/**
 * SCA DSH Plugin Contract
 *
 * 设计原则：
 * - Model-facing API 只暴露语义对象
 * - 不暴露 Chrome TabId / DOM Selector / IndexedDB Key
 * - State / Evidence / Policy / Mission 均有明确权威归属
 */

export type Authority =
  | "OBSERVED"
  | "INFERRED"
  | "DERIVED"
  | "RETRACTED";

export type MissionState =
  | "CREATED"
  | "PLANNING"
  | "DISCOVERING"
  | "COLLECTING"
  | "EVALUATING"
  | "AWAITING_APPROVAL"
  | "EXECUTING"
  | "VERIFYING"
  | "COMPLETED"
  | "PAUSED"
  | "FAILED"
  | "CANCELLED";

export type MissionKind =
  | "JOB_SEARCH"
  | "JOB_INSPECTION"
  | "JOB_APPLICATION";

export type PolicyEffect =
  | "ALLOW"
  | "DENY"
  | "APPROVAL_REQUIRED";

export type FailureCategory =
  | "VALIDATION"
  | "POLICY"
  | "NETWORK"
  | "PROVIDER"
  | "AUTH"
  | "TIMEOUT"
  | "CONFLICT"
  | "UNKNOWN";

export interface FailureState {
  code: string;
  category: FailureCategory;
  message: string;
  recoverable: boolean;
  retryable: boolean;
  nextAction?: string;
  details?: unknown;
}

export interface EvidenceSource {
  providerId: string;
  uri?: string;
  observedAt: number;
  locator?: string;
}

export interface Evidence<T = unknown> {
  id: string;
  claimKey: string;
  value: T;
  authority: Authority;
  source?: EvidenceSource;
  confidence?: number;
  createdAt: number;
  retractedAt?: number;
}

export interface CareerConstraint {
  location?: string;
  minimumSalary?: number;
  maximumSalary?: number;
  salaryCurrency?: string;
  blockedKeywords?: string[];
  blockedPlatforms?: string[];
  preferredPlatforms?: string[];
  remoteOnly?: boolean;
  minimumMatchScore?: number;
  directHireOnly?: boolean;
}

export interface CareerState {
  version: number;
  identityAnchor?: string;
  targetRoles: string[];
  hardSkills: string[];
  softSkills: string[];
  achievements: string[];
  constraints: CareerConstraint;
  source: "SCA";
  updatedAt: number;
}

export interface Job {
  id: string;
  title: string;
  company?: string;
  location?: string;
  salary?: string;
  platform?: string;
  url: string;

  /**
   * 现实世界字段尽可能带证据。
   */
  evidence: Evidence[];

  /**
   * 计算结果不能冒充 Observation。
   */
  matchScore?: number;
}

export interface JobMatch {
  jobId: string;
  score: number;
  strengths: string[];
  gaps: string[];
  risks: string[];
  derivedFromEvidenceIds: string[];
}

export interface JobSearchRequest {
  query: string;
  constraints?: CareerConstraint;
  limit?: number;
}

export interface JobSearchResult {
  missionId: string;
  state: MissionState;
  results: Job[];
  total: number;
  hasMore: boolean;
  nextAction?: string;
}

export interface JobInspectRequest {
  jobId: string;
}

export interface JobInspectResult {
  missionId: string;
  job: Job;
  match?: JobMatch;
}

export interface ApplyRequest {
  jobId: string;
  resumeId?: string;
  message?: string;
  approvalToken?: string;
}

export interface ApplicationResult {
  missionId: string;
  jobId: string;
  state: MissionState;

  /**
   * Never return "success=true" without evidence.
   */
  verification?: Evidence[];
  failure?: FailureState;
}

export interface MissionRecord {
  id: string;
  kind: MissionKind;
  state: MissionState;
  createdAt: number;
  updatedAt: number;

  input: unknown;

  checkpoint?: unknown;

  failure?: FailureState;

  correlationId: string;
  operationId: string;
}

export interface MissionStatus {
  mission: MissionRecord;
}

export interface ApprovalRequest {
  missionId: string;
  reason: string;
  requestedAt: number;
  expiresAt?: number;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  reason: string;
  approval?: ApprovalRequest;
}
EOF

# ============================================================
# 2. contract/evidence.ts
# ============================================================

cat > "$BASE/contract/evidence.ts" <<'EOF'
import type {
  Authority,
  Evidence,
  EvidenceSource,
} from "./types";

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * EvidenceFactory
 *
 * 这是插件内部的统一 Evidence 构造入口。
 *
 * 注意：
 * 本工厂不负责决定现实事实真假。
 * OBSERVED 必须由 Provider/Observation Adapter 提供来源。
 */
export class EvidenceFactory {
  observed<T>(
    claimKey: string,
    value: T,
    source: EvidenceSource,
    options?: {
      confidence?: number;
    },
  ): Evidence<T> {
    return this.create(
      claimKey,
      value,
      "OBSERVED",
      source,
      options?.confidence,
    );
  }

  inferred<T>(
    claimKey: string,
    value: T,
    options?: {
      confidence?: number;
      source?: EvidenceSource;
    },
  ): Evidence<T> {
    return this.create(
      claimKey,
      value,
      "INFERRED",
      options?.source,
      options?.confidence,
    );
  }

  derived<T>(
    claimKey: string,
    value: T,
    options?: {
      confidence?: number;
      source?: EvidenceSource;
    },
  ): Evidence<T> {
    return this.create(
      claimKey,
      value,
      "DERIVED",
      options?.source,
      options?.confidence,
    );
  }

  retract<T>(
    evidence: Evidence<T>,
    timestamp = Date.now(),
  ): Evidence<T> {
    return {
      ...evidence,
      authority: "RETRACTED",
      retractedAt: timestamp,
    };
  }

  private create<T>(
    claimKey: string,
    value: T,
    authority: Authority,
    source?: EvidenceSource,
    confidence?: number,
  ): Evidence<T> {
    return {
      id: generateId("ev"),
      claimKey,
      value,
      authority,
      source,
      confidence,
      createdAt: Date.now(),
    };
  }
}
EOF

# ============================================================
# 3. contract/policy.ts
# ============================================================

cat > "$BASE/contract/policy.ts" <<'EOF'
import type {
  ApplyRequest,
  CareerConstraint,
  PolicyDecision,
} from "./types";

export interface PolicyContext {
  constraints: CareerConstraint;
  action: "SEARCH" | "INSPECT" | "APPLY";
}

export interface PolicyEngine {
  evaluate(
    context: PolicyContext,
    request?: ApplyRequest,
  ): Promise<PolicyDecision>;
}

/**
 * 第一版最小 Policy。
 *
 * 后续应该把现有 SCA rule-engine / UserConstitution
 * 通过 Adapter 接入，而不是复制一套规则。
 */
export class DefaultPolicyEngine implements PolicyEngine {
  async evaluate(
    context: PolicyContext,
    request?: ApplyRequest,
  ): Promise<PolicyDecision> {
    if (context.action !== "APPLY") {
      return {
        effect: "ALLOW",
        reason: "Read-only capability does not require approval.",
      };
    }

    if (request?.approvalToken) {
      return {
        effect: "ALLOW",
        reason: "Explicit approval token supplied.",
      };
    }

    return {
      effect: "APPROVAL_REQUIRED",
      reason: "External side effect requires runtime approval.",
      approval: {
        missionId: "pending",
        reason: "Job application is an external side effect.",
        requestedAt: Date.now(),
      },
    };
  }
}
EOF

# ============================================================
# 4. contract/mission.ts
# ============================================================

cat > "$BASE/contract/mission.ts" <<'EOF'
import type {
  FailureState,
  MissionKind,
  MissionRecord,
  MissionState,
} from "./types";

const TERMINAL_STATES = new Set<MissionState>([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

const TRANSITIONS: Record<MissionState, MissionState[]> = {
  CREATED: ["PLANNING", "CANCELLED", "FAILED"],
  PLANNING: ["DISCOVERING", "COLLECTING", "AWAITING_APPROVAL", "PAUSED", "FAILED", "CANCELLED"],
  DISCOVERING: ["COLLECTING", "PAUSED", "FAILED", "CANCELLED"],
  COLLECTING: ["EVALUATING", "PAUSED", "FAILED", "CANCELLED"],
  EVALUATING: ["AWAITING_APPROVAL", "COMPLETED", "PAUSED", "FAILED", "CANCELLED"],
  AWAITING_APPROVAL: ["EXECUTING", "PAUSED", "FAILED", "CANCELLED"],
  EXECUTING: ["VERIFYING", "PAUSED", "FAILED", "CANCELLED"],
  VERIFYING: ["COMPLETED", "PAUSED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  PAUSED: ["PLANNING", "DISCOVERING", "COLLECTING", "EVALUATING", "AWAITING_APPROVAL", "EXECUTING", "VERIFYING", "CANCELLED", "FAILED"],
  FAILED: ["PLANNING", "DISCOVERING", "COLLECTING", "EVALUATING", "AWAITING_APPROVAL", "EXECUTING", "VERIFYING", "CANCELLED"],
  CANCELLED: [],
};

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function isTerminalState(state: MissionState): boolean {
  return TERMINAL_STATES.has(state);
}

export function canTransition(
  current: MissionState,
  next: MissionState,
): boolean {
  return TRANSITIONS[current]?.includes(next) ?? false;
}

export interface MissionRepository {
  create(
    kind: MissionKind,
    input: unknown,
    correlationId: string,
    operationId: string,
  ): Promise<MissionRecord>;

  get(id: string): Promise<MissionRecord | null>;

  update(
    id: string,
    patch: Partial<Omit<MissionRecord, "id">>,
  ): Promise<MissionRecord>;

  checkpoint(
    id: string,
    checkpoint: unknown,
  ): Promise<MissionRecord>;
}

export class InMemoryMissionRepository implements MissionRepository {
  private readonly records = new Map<string, MissionRecord>();

  async create(
    kind: MissionKind,
    input: unknown,
    correlationId: string,
    operationId: string,
  ): Promise<MissionRecord> {
    const now = Date.now();

    const record: MissionRecord = {
      id: generateId("mission"),
      kind,
      state: "CREATED",
      createdAt: now,
      updatedAt: now,
      input,
      correlationId,
      operationId,
    };

    this.records.set(record.id, record);

    return structuredClone(record);
  }

  async get(id: string): Promise<MissionRecord | null> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }

  async update(
    id: string,
    patch: Partial<Omit<MissionRecord, "id">>,
  ): Promise<MissionRecord> {
    const current = this.records.get(id);

    if (!current) {
      throw new Error(`MISSION_NOT_FOUND:${id}`);
    }

    if (patch.state && patch.state !== current.state) {
      if (!canTransition(current.state, patch.state)) {
        throw new Error(
          `INVALID_MISSION_TRANSITION:${current.state}->${patch.state}`,
        );
      }
    }

    const next: MissionRecord = {
      ...current,
      ...patch,
      updatedAt: Date.now(),
    };

    this.records.set(id, next);

    return structuredClone(next);
  }

  async checkpoint(
    id: string,
    checkpoint: unknown,
  ): Promise<MissionRecord> {
    return this.update(id, { checkpoint });
  }
}

export function missionFailure(
  code: string,
  category: FailureState["category"],
  message: string,
  options?: Partial<FailureState>,
): FailureState {
  return {
    code,
    category,
    message,
    recoverable: options?.recoverable ?? false,
    retryable: options?.retryable ?? false,
    nextAction: options?.nextAction,
    details: options?.details,
  };
}
EOF

# ============================================================
# 5. providers/types.ts
# ============================================================

cat > "$BASE/providers/types.ts" <<'EOF'
import type {
  ApplyRequest,
  Evidence,
  Job,
  JobInspectResult,
  JobSearchRequest,
} from "../contract/types";

export interface SearchProvider {
  search(
    request: JobSearchRequest,
    signal?: AbortSignal,
  ): Promise<{
    jobs: Job[];
    evidence: Evidence[];
  }>;
}

export interface InspectionProvider {
  inspect(
    jobId: string,
    signal?: AbortSignal,
  ): Promise<JobInspectResult>;
}

export interface ApplicationProvider {
  apply(
    request: ApplyRequest,
    signal?: AbortSignal,
  ): Promise<{
    accepted: boolean;
    evidence: Evidence[];
    failure?: {
      code: string;
      message: string;
      retryable: boolean;
    };
  }>;
}

/**
 * Capability Provider Aggregate
 *
 * SCA Core 通过这一层接入真正的浏览器、招聘平台、邮件等现实世界能力。
 */
export interface SCAProvider {
  readonly id: string;

  search: SearchProvider;
  inspection: InspectionProvider;
  application: ApplicationProvider;
}
EOF

# ============================================================
# 6. providers/sca-provider.ts
# ============================================================

cat > "$BASE/providers/sca-provider.ts" <<'EOF'
import type {
  ApplyRequest,
  Evidence,
  Job,
  JobInspectResult,
  JobSearchRequest,
} from "../contract/types";
import type { SCAProvider } from "./types";

/**
 * 第一版 Provider。
 *
 * 这是一个"接口完整、默认不接管现有逻辑"的 Null Provider。
 *
 * 原因：
 * 不在 DSH Plugin 层复制当前 SCA 的抓取/浏览器逻辑。
 * 后续通过 adapter/sca-runtime-adapter.ts 接到：
 *
 * - SeedGenerator
 * - shadowTabExecutor
 * - WDL Engine
 * - localBatchHeuristicClean
 * - policy / event store
 */
export class NullSCAProvider implements SCAProvider {
  readonly id = "sca.null";

  search = {
    async search(
      _request: JobSearchRequest,
      _signal?: AbortSignal,
    ): Promise<{ jobs: Job[]; evidence: Evidence[] }> {
      return {
        jobs: [],
        evidence: [],
      };
    },
  };

  inspection = {
    async inspect(
      jobId: string,
      _signal?: AbortSignal,
    ): Promise<JobInspectResult> {
      throw new Error(
        `PROVIDER_NOT_CONNECTED: inspection:${jobId}`,
      );
    },
  };

  application = {
    async apply(
      request: ApplyRequest,
      _signal?: AbortSignal,
    ): Promise<{
      accepted: boolean;
      evidence: Evidence[];
      failure?: {
        code: string;
        message: string;
        retryable: boolean;
      };
    }> {
      return {
        accepted: false,
        evidence: [],
        failure: {
          code: "PROVIDER_NOT_CONNECTED",
          message: `Application provider is not connected for job ${request.jobId}`,
          retryable: false,
        },
      };
    },
  };
}
EOF

# ============================================================
# 7. services/career-service.ts
# ============================================================

cat > "$BASE/services/career-service.ts" <<'EOF'
import type {
  ApplyRequest,
  CareerState,
  JobInspectRequest,
  JobInspectResult,
  JobSearchRequest,
  JobSearchResult,
  MissionRecord,
  MissionState,
} from "../contract/types";
import {
  InMemoryMissionRepository,
} from "../contract/mission";
import {
  DefaultPolicyEngine,
  type PolicyEngine,
} from "../contract/policy";
import { EvidenceFactory } from "../contract/evidence";
import type { SCAProvider } from "../providers/types";

export interface CareerStateProvider {
  getCareerState(): Promise<CareerState>;
}

export interface CareerServiceDependencies {
  careerState: CareerStateProvider;
  provider: SCAProvider;
  missionRepository?: InMemoryMissionRepository;
  policyEngine?: PolicyEngine;
  evidenceFactory?: EvidenceFactory;
}

function generateOperationId(): string {
  return `op_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export class CareerService {
  private readonly missions: InMemoryMissionRepository;
  private readonly policy: PolicyEngine;
  private readonly evidence: EvidenceFactory;

  constructor(
    private readonly deps: CareerServiceDependencies,
  ) {
    this.missions =
      deps.missionRepository ?? new InMemoryMissionRepository();

    this.policy =
      deps.policyEngine ?? new DefaultPolicyEngine();

    this.evidence =
      deps.evidenceFactory ?? new EvidenceFactory();
  }

  async search(
    request: JobSearchRequest,
  ): Promise<JobSearchResult> {
    const operationId = generateOperationId();

    const mission = await this.missions.create(
      "JOB_SEARCH",
      request,
      operationId,
      operationId,
    );

    await this.transition(mission.id, "PLANNING");

    const careerState =
      await this.deps.careerState.getCareerState();

    const effectiveRequest: JobSearchRequest = {
      ...request,
      constraints: {
        ...careerState.constraints,
        ...request.constraints,
      },
    };

    await this.transition(mission.id, "DISCOVERING");

    const result = await this.deps.provider.search.search(
      effectiveRequest,
    );

    await this.missions.checkpoint(mission.id, {
      resultCount: result.jobs.length,
      evidenceCount: result.evidence.length,
    });

    await this.transition(mission.id, "COLLECTING");
    await this.transition(mission.id, "EVALUATING");
    await this.transition(mission.id, "COMPLETED");

    return {
      missionId: mission.id,
      state: "COMPLETED",
      results: result.jobs,
      total: result.jobs.length,
      hasMore: false,
    };
  }

  async inspect(
    request: JobInspectRequest,
  ): Promise<JobInspectResult> {
    const operationId = generateOperationId();

    const mission = await this.missions.create(
      "JOB_INSPECTION",
      request,
      operationId,
      operationId,
    );

    await this.transition(mission.id, "PLANNING");
    await this.transition(mission.id, "COLLECTING");

    const result =
      await this.deps.provider.inspection.inspect(
        request.jobId,
      );

    await this.transition(mission.id, "EVALUATING");
    await this.transition(mission.id, "COMPLETED");

    return {
      ...result,
      missionId: mission.id,
    };
  }

  async apply(
    request: ApplyRequest,
  ) {
    const operationId = generateOperationId();

    const mission = await this.missions.create(
      "JOB_APPLICATION",
      request,
      operationId,
      operationId,
    );

    await this.transition(mission.id, "PLANNING");

    const careerState =
      await this.deps.careerState.getCareerState();

    const decision = await this.policy.evaluate(
      {
        action: "APPLY",
        constraints: careerState.constraints,
      },
      request,
    );

    if (decision.effect === "DENY") {
      await this.failMission(
        mission.id,
        "POLICY_DENIED",
        "POLICY",
        decision.reason,
      );

      return {
        missionId: mission.id,
        jobId: request.jobId,
        state: "FAILED" as MissionState,
        failure: {
          code: "POLICY_DENIED",
          category: "POLICY",
          message: decision.reason,
          recoverable: false,
          retryable: false,
        },
      };
    }

    if (decision.effect === "APPROVAL_REQUIRED") {
      await this.transition(
        mission.id,
        "AWAITING_APPROVAL",
      );

      return {
        missionId: mission.id,
        jobId: request.jobId,
        state: "AWAITING_APPROVAL" as MissionState,
        approvalRequired: true,
        reason: decision.reason,
      };
    }

    await this.transition(mission.id, "EXECUTING");

    const result =
      await this.deps.provider.application.apply(
        request,
      );

    await this.transition(mission.id, "VERIFYING");

    if (!result.accepted) {
      await this.failMission(
        mission.id,
        result.failure?.code ?? "APPLICATION_FAILED",
        "PROVIDER",
        result.failure?.message ??
          "Application provider rejected the operation.",
      );

      return {
        missionId: mission.id,
        jobId: request.jobId,
        state: "FAILED" as MissionState,
        verification: result.evidence,
        failure: {
          code:
            result.failure?.code ??
            "APPLICATION_FAILED",
          category: "PROVIDER",
          message:
            result.failure?.message ??
            "Application failed.",
          recoverable: result.failure?.retryable ?? false,
          retryable: result.failure?.retryable ?? false,
        },
      };
    }

    await this.transition(mission.id, "COMPLETED");

    return {
      missionId: mission.id,
      jobId: request.jobId,
      state: "COMPLETED" as MissionState,
      verification: result.evidence,
    };
  }

  async getMission(
    id: string,
  ): Promise<MissionRecord | null> {
    return this.missions.get(id);
  }

  async pause(
    id: string,
  ): Promise<MissionRecord> {
    return this.transition(id, "PAUSED");
  }

  async cancel(
    id: string,
  ): Promise<MissionRecord> {
    return this.transition(id, "CANCELLED");
  }

  private async transition(
    missionId: string,
    state: MissionState,
  ): Promise<MissionRecord> {
    return this.missions.update(
      missionId,
      { state },
    );
  }

  private async failMission(
    missionId: string,
    code: string,
    category:
      | "VALIDATION"
      | "POLICY"
      | "NETWORK"
      | "PROVIDER"
      | "AUTH"
      | "TIMEOUT"
      | "CONFLICT"
      | "UNKNOWN",
    message: string,
  ): Promise<void> {
    await this.missions.update(
      missionId,
      {
        state: "FAILED",
        failure: {
          code,
          category,
          message,
          recoverable: false,
          retryable: false,
        },
      },
    );
  }
}
EOF

# ============================================================
# 8. services/mission-service.ts
# ============================================================

cat > "$BASE/services/mission-service.ts" <<'EOF'
import type {
  MissionRecord,
  MissionStatus,
} from "../contract/types";
import type { CareerService } from "./career-service";

export class MissionService {
  constructor(
    private readonly careerService: CareerService,
  ) {}

  async status(
    missionId: string,
  ): Promise<MissionStatus> {
    const mission =
      await this.careerService.getMission(missionId);

    if (!mission) {
      throw new Error(
        `MISSION_NOT_FOUND:${missionId}`,
      );
    }

    return { mission };
  }

  async pause(
    missionId: string,
  ): Promise<MissionRecord> {
    return this.careerService.pause(missionId);
  }

  async cancel(
    missionId: string,
  ): Promise<MissionRecord> {
    return this.careerService.cancel(missionId);
  }
}
EOF

# ============================================================
# 9. adapter/sca-runtime-adapter.ts
# ============================================================

cat > "$BASE/adapter/sca-runtime-adapter.ts" <<'EOF'
import type {
  CareerState,
  Evidence,
  Job,
  JobInspectResult,
  JobSearchRequest,
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
 * 当前版本先提供"可运行的最小 Adapter"。
 * 下一阶段再把当前项目已有实现接进来。
 */

export interface ExistingSCARuntime {
  /**
   * 当前 SCA 职业画像 / Constitution 的读取入口。
   */
  getCareerState(): Promise<CareerState>;

  /**
   * 搜索职位。
   *
   * 这里后续应该桥接到：
   * SeedGenerator → Traversal → Observation → Matcher
   */
  searchJobs(
    request: JobSearchRequest,
    signal?: AbortSignal,
  ): Promise<{
    jobs: Job[];
    evidence: Evidence[];
  }>;

  /**
   * 检查职位。
   */
  inspectJob(
    jobId: string,
    signal?: AbortSignal,
  ): Promise<JobInspectResult>;

  /**
   * 实际投递。
   *
   * 这里必须经过当前 SCA Policy / Approval。
   */
  applyJob(
    request: {
      jobId: string;
      resumeId?: string;
      message?: string;
      approvalToken?: string;
    },
    signal?: AbortSignal,
  ): Promise<{
    accepted: boolean;
    evidence: Evidence[];
    failure?: {
      code: string;
      message: string;
      retryable: boolean;
    };
  }>;
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
    apply: async (
      request: {
        jobId: string;
        resumeId?: string;
        message?: string;
        approvalToken?: string;
      },
      signal?: AbortSignal,
    ) => {
      if (!this.runtime) {
        return this.fallback.application.apply(
          request,
          signal,
        );
      }

      return this.runtime.applyJob(
        request,
        signal,
      );
    },
  };
}
EOF

# ============================================================
# 10. manifest.ts
# ============================================================

cat > "$BASE/manifest.ts" <<'EOF'
/**
 * DSH-facing Plugin Manifest
 *
 * 这里刻意保持非常小。
 * Model 不应该看到 SCA 内部几十个函数。
 */

export const SCA_DSH_PLUGIN_MANIFEST = {
  id: "sca",
  version: "1.0.0",
  name: "Sovereign Career Agent",
  description:
    "Career capability provider for DeepSeek Harness.",
  capability: "career",

  stateAuthorities: [
    "career_state",
    "mission_state",
    "evidence",
  ],

  capabilities: {
    search: {
      id: "career.search",
      mode: "mission",
      readOnly: true,
    },

    inspect: {
      id: "career.inspect",
      mode: "mission",
      readOnly: true,
    },

    apply: {
      id: "career.apply",
      mode: "mission",
      readOnly: false,
      requiresPolicy: true,
      mayRequireApproval: true,
    },

    mission: {
      id: "career.mission",
      mode: "runtime",
      operations: [
        "status",
        "pause",
        "cancel",
      ],
    },
  },

  forbiddenModelSurface: [
    "chrome.tabs.*",
    "chrome.scripting.*",
    "dom_selector",
    "css_selector",
    "xpath",
    "indexeddb_key",
    "tab_id",
    "wdl_locator",
    "internal_event_id",
  ],

  lifecycle: [
    "activate",
    "pause",
    "resume",
    "stop",
    "dispose",
  ],

  contract: {
    cognition: "DSH",
    capability: "SCA",
    reality: "SCA_PROVIDER",
  },
} as const;
EOF

# ============================================================
# 11. index.ts
# ============================================================

cat > "$BASE/index.ts" <<'EOF'
import type {
  ApplyRequest,
  JobInspectRequest,
  JobSearchRequest,
} from "./contract/types";

import {
  DefaultPolicyEngine,
} from "./contract/policy";

import {
  InMemoryMissionRepository,
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
  SCA_DSH_PLUGIN_MANIFEST,
} from "./manifest";

/**
 * SCA DSH Plugin
 *
 * 这是唯一应该被 DSH Runtime 挂载的入口。
 */
export class SCADSHPlugin {
  readonly manifest =
    SCA_DSH_PLUGIN_MANIFEST;

  readonly career: CareerService;
  readonly mission: MissionService;

  constructor(
    runtime: ExistingSCARuntime | null = null,
  ) {
    const dependencies:
      CareerServiceDependencies = {
        careerState:
          new SCACareerStateAdapter(runtime),

        provider:
          new SCARuntimeProvider(runtime),

        missionRepository:
          new InMemoryMissionRepository(),

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
   */
  async search(
    request: JobSearchRequest,
  ) {
    return this.career.search(request);
  }

  /**
   * DSH Capability: inspect
   */
  async inspect(
    request: JobInspectRequest,
  ) {
    return this.career.inspect(request);
  }

  /**
   * DSH Capability: apply
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
}

export * from "./manifest";
export * from "./contract/types";
export * from "./contract/evidence";
export * from "./contract/policy";
export * from "./contract/mission";
export * from "./providers/types";
export * from "./providers/sca-provider";
export * from "./services/career-service";
export * from "./services/mission-service";
export * from "./adapter/sca-runtime-adapter";
EOF

# ============================================================
# 12. README.md
# ============================================================

cat > "$BASE/README.md" <<'EOF'
# SCA DSH Plugin

Sovereign Career Agent capability provider for DeepSeek Harness.

## Architecture

\`\`\`text
DeepSeek Harness
       |
       v
Capability Seam
       |
       v
SCADSHPlugin
       |
       +--------------------+
       |                    |
       v                    v
CareerService          MissionService
       |
       +----------+-----------+
       |          |           |
       v          v           v
    Policy     State       Evidence
       |
       v
SCARuntimeProvider
       |
       v
Existing SCA Runtime
       |
       +----------------------+
       |           |          |
       v           v          v
    WDL/DOM    Traversal   Matcher
       |
       v
Reality
\`\`\`

## Model-facing capabilities

Only expose:

- \`career.search\`
- \`career.inspect\`
- \`career.apply\`
- \`career.mission\`

Never expose:

- Chrome TabId
- DOM selector
- XPath
- IndexedDB key
- WDL locator
- internal event id
- browser implementation details

## Authority model

- \`OBSERVED\`  -> reality evidence
- \`INFERRED\`  -> model reasoning
- \`DERIVED\`   -> deterministic computation
- \`RETRACTED\` -> no longer trusted

## Runtime rule

\`\`\`text
Model
  -> request
  -> Policy
  -> Mission
  -> Provider
  -> Reality
\`\`\`

No LLM output is automatically promoted to \`OBSERVED\`.

## Current state

The plugin layer is intentionally runnable without the existing SCA runtime.

The next integration step is to implement \`ExistingSCARuntime\` against the current SCA modules.
EOF

# ============================================================
# 13. Optional root export
# ============================================================

if [ -f "$ROOT/src/shared/index.ts" ]; then
  if ! grep -q 'dsh-plugin' "$ROOT/src/shared/index.ts" 2>/dev/null; then
    cat >> "$ROOT/src/shared/index.ts" <<'EOF'

/**
 * SCA DSH Plugin public surface.
 *
 * 注意：
 * 这里只导出 Plugin Contract。
 * 不向旧模块泄漏 DSH Runtime 细节。
 */
export * from "../dsh-plugin";
EOF
  fi
fi

echo
echo "[SCA-DSH] Created:"
find "$BASE" -type f | sort
echo
echo "[SCA-DSH] Done."
echo
echo "Next:"
echo " 1. npm run build"
echo " 2. connect ExistingSCARuntime to current SCA core"
echo " 3. replace InMemoryMissionRepository with SCA persistent mission state"
echo " 4. wire DSH Runtime to SCADSHPlugin"
