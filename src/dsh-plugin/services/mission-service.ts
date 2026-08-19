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

  /**
   * 批准处于 AWAITING_APPROVAL 状态的 Mission，继续执行 EXECUTING → VERIFYING → COMPLETED。
   */
  async approve(
    missionId: string,
    approvalToken?: string,
  ) {
    return this.careerService.approve(missionId, approvalToken);
  }

  /**
   * 拒绝处于 AWAITING_APPROVAL 状态的 Mission，进入 CANCELLED。
   */
  async deny(
    missionId: string,
    reason?: string,
  ) {
    return this.careerService.deny(missionId, reason);
  }
}
