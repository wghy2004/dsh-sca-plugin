# SCA DSH Plugin

Sovereign Career Agent capability provider for DeepSeek Harness.

## Architecture

```text
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
       |                    |
       +----------+---------+ approve / deny
       |          |
       v          v
    Policy     State
       |          |
       +----------+---------+
                  |
                  v
            Evidence (Authority Gate)
                  |
                  v
          SCARuntimeProvider
                  |
                  v
          SCACoreRuntime (runtime/)
                  |
     +------------+------------+
     v            v            v
  Profile     Seed/Traversal  WDL/Browser
     |            |            |
     +------------+------------+
                  |
                  v
            Observation
                  |
                  v
        ProvenanceVerifier (policy)
                  |
                  v
            OBSERVED Evidence
                  |
                  v
            Event Store (db)
                  |
                  v
           Projection (projection)
```

## Authority Model (Phase A 修正)

| Authority   | 产生者                         | 说明                                   |
|-------------|-------------------------------|----------------------------------------|
| `OBSERVED`  | SCA Runtime / ProvenanceVerifier | 现实世界事实，Plugin 内部不能伪造       |
| `INFERRED`  | EvidenceFactory.inferred()    | 模型推理，confidence 表达可信度         |
| `DERIVED`   | EvidenceFactory.derived()     | 确定性计算，必须追溯上游 OBSERVED       |
| `RETRACTED` | EvidenceFactory.retract()     | 已被证伪，不再被信任                    |

**关键约束**：`EvidenceFactory` 不再提供 `observed()` 方法。所有 OBSERVED Evidence 必须通过 `runtime/evidence-mapper.ts` 从 SCA Event Store 提取。

## Model-facing Capabilities

Only expose:

- `career.search` — 只读，不需要审批
- `career.inspect` — 只读，不需要审批
- `career.apply` — 外部副作用，必须经过 Policy + Approval + Verify
- `career.mission` — status / pause / cancel / approve / deny

Never expose:

- Chrome TabId
- DOM selector
- XPath
- IndexedDB key
- WDL locator
- internal event id
- browser implementation details

## Apply Flow (三段式闭环)

```text
career.apply(request)
    │
    ▼
CREATE Mission → PLANNING
    │
    ▼
prepare()  ← 评估可行性，不产生副作用
    │
    ├── blockers → FAILED
    │
    ▼
Policy Gate
    │
    ├── DENY → FAILED
    │
    ├── APPROVAL_REQUIRED → AWAITING_APPROVAL
    │       │
    │   ┌───┴────┐
    │   ▼        ▼
    │ approve   deny
    │   │        │
    │   ▼        ▼
    │ EXECUTING  CANCELLED
    │
    └── ALLOW → EXECUTING
            │
            ▼
        execute()  ← 触发外部行动
            │
            ▼
        VERIFYING
            │
            ▼
        verify()  ← 基于 OBSERVED Evidence 确认
            │
            ├── confirmed + OBSERVED → COMPLETED
            └── no OBSERVED → FAILED (VERIFICATION_FAILED)
```

**关键原则**：`accepted: true` 不等于成功。没有 OBSERVED Evidence 就不能进入 COMPLETED。

## Mission Record (执行实例)

```typescript
interface MissionRecord {
  id, kind, state, createdAt, updatedAt
  correlationId, operationId
  input, checkpoint
  pendingApproval?: ApprovalRequest   // AWAITING_APPROVAL 时填充
  action?: MissionAction               // 外部行动执行记录
  verification?: MissionVerification   // 必须基于 OBSERVED Evidence
  failure?: FailureState
}
```

## Runtime Integration (Phase B-E)

`runtime/sca-core-runtime.ts` 实现了 `ExistingSCARuntime` 接口，对接 SCA Core：

| 方法               | SCA Core 对接                                                                 |
|--------------------|------------------------------------------------------------------------------|
| `getCareerState`   | `getActiveProfile()` + `getConstitution()` → CareerState 语义投影             |
| `searchJobs`       | `SeedGenerator` → `shadowTabExecutor.enqueue` → `startTraversal` → `getInteractionStates` |
| `inspectJob`       | 查找 InteractionState → 触发 Observation → `processObservation` → Event Store |
| `prepareApply`     | `getActiveProfile()` + `evaluateActionGate()`                                 |
| `executeApply`     | `appendIntent(FORM_FILL)` → `shadowTabExecutor.startTraversal()`              |
| `verifyApply`      | Event Store 查找 PLATFORM_DISPATCH/FORM_DISPATCH 决策 → OBSERVED Evidence     |

### 使用方式

```typescript
import { SCADSHPlugin, SCACoreRuntime } from "./dsh-plugin";

// 接入真实 SCA Core
const plugin = new SCADSHPlugin(new SCACoreRuntime());

// 搜索
const result = await plugin.search({ query: "Java 后端", constraints: { location: "北京" } });

// 投递（需要审批）
const applyResult = await plugin.apply({ jobId: "company_123" });
if (applyResult.state === "AWAITING_APPROVAL") {
  const approved = await plugin.missionApprove(applyResult.missionId);
}
```

## Directory Structure

```
src/dsh-plugin/
├── manifest.ts                 # DSH-facing 插件清单
├── index.ts                    # 唯一对外入口 SCADSHPlugin
├── README.md
├── contract/
│   ├── types.ts                # Authority / Mission / Evidence / Job 语义类型
│   ├── evidence.ts             # EvidenceFactory (仅 INFERRED/DERIVED/RETRACTED)
│   ├── policy.ts               # DefaultPolicyEngine
│   └── mission.ts              # 状态机 + MissionRepository
├── services/
│   ├── career-service.ts       # search/inspect/apply + approve/deny
│   └── mission-service.ts      # status/pause/cancel/approve/deny
├── providers/
│   ├── types.ts                # Search/Inspection/Application Provider 接口
│   └── sca-provider.ts         # NullSCAProvider
├── adapter/
│   └── sca-runtime-adapter.ts  # ExistingSCARuntime 边界 + Adapter
└── runtime/
    ├── index.ts
    ├── sca-core-runtime.ts     # ExistingSCARuntime 真实实现（对接 SCA Core）
    └── evidence-mapper.ts      # SCA Event → DSH Evidence（OBSERVED 唯一来源）
```

## Next Steps (Phase F)

- [ ] 将 `InMemoryMissionRepository` 替换为 `SCAMissionRepository`，基于 SCA Event Store
- [ ] Mission 状态变更发出领域事件（MissionCreated / MissionCompleted 等）
- [ ] 第一个验收场景："找北京 30K+ Java 后端，筛选匹配度最高的 5 个"
- [ ] 第二个验收场景："把第 2 个岗位投了"（走完整 apply → approve → execute → verify 闭环）
