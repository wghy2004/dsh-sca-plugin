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
