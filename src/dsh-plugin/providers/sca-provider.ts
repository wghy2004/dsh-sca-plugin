import type {
  ActionReceipt,
  ApplyPreparation,
  ApplyRequest,
  Evidence,
  Job,
  JobInspectResult,
  JobSearchRequest,
  VerificationResult,
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
    async prepare(
      request: ApplyRequest,
      _signal?: AbortSignal,
    ): Promise<ApplyPreparation> {
      return {
        missionId: "pending",
        jobId: request.jobId,
        ready: false,
        blockers: ["PROVIDER_NOT_CONNECTED"],
      };
    },

    async execute(
      missionId: string,
      _approvalToken?: string,
      _signal?: AbortSignal,
    ): Promise<ActionReceipt> {
      return {
        missionId,
        accepted: false,
        evidence: [],
        failure: {
          code: "PROVIDER_NOT_CONNECTED",
          message: `Application provider is not connected for mission ${missionId}`,
          retryable: false,
        },
      };
    },

    async verify(
      missionId: string,
      _signal?: AbortSignal,
    ): Promise<VerificationResult> {
      return {
        missionId,
        confirmed: false,
        evidence: [],
        summary: "PROVIDER_NOT_CONNECTED: cannot verify application status",
        failure: {
          code: "PROVIDER_NOT_CONNECTED",
          message: `Verification provider is not connected for mission ${missionId}`,
          retryable: false,
        },
      };
    },
  };
}
