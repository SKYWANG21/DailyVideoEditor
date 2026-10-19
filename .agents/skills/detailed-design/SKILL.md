---
name: detailed-design
description: >-
  Generates feature detailed design documents (详细设计) following the project
  standard template. Use when writing 详细设计、详细设计文档、feature design、技术设计,
  or when the user asks to produce design docs from PRD/UX for ai-video-java.
---

# 详细设计文档生成

按项目标准模板产出「需求 → 流程 → 模块 → 数据库 → 接口」完整详细设计，供开发直接落地。

## 触发条件

- 用户要求写/生成「详细设计」「技术设计」「feature design」
- 用户提供了 PRD、UX 原型或需求描述，需要产出设计文档
- 用户引用 `@开发计划/*-详细设计.md` 并要求按同样格式写新功能

## 前置输入（向用户确认缺失项）

| 输入 | 用途 |
| --- | --- |
| PRD / 需求说明 | 1.1 背景目标、1.2 关联需求、1.6 验收标准 |
| UX 原型或截图 | 1.7 PRD/UX 差异、前端交互、按钮文案 |
| 现有代码/表结构 | 复用点、3.1 模块树、4.x 数据库 |
| 第三方 API 文档 | 5.4 内部接口、R-xx 风险项 |

**缺 PRD 时**：先基于用户描述起草，在 1.7 与附录 B 标注「待确认」项，勿编造已决业务规则。

## 输出规范

- **路径**：`开发计划/{功能中文名}-详细设计.md`
- **语言**：简体中文
- **图表**：Mermaid（flowchart / sequenceDiagram / stateDiagram-v2 / erDiagram）
- **ID 编号**：需求 `FR-xxx`、场景 `US-xxx`、模块 `M-xxx`、任务 `T-xxx`、接口 `API-xxx`、待决 `OQ-xxx`、风险 `R-xxx`、设计决策 `D-xxx`

## 生成工作流

```
Task Progress:
- [ ] 1. 阅读 PRD/UX，列出 In Scope / Out of Scope
- [ ] 2. 搜索代码库，找可复用 Service、表、API、前端页面
- [ ] 3. 按 template.md 逐章填充（先骨架后细节）
- [ ] 4. 画流程图：用户主路径 + 后台任务 + 状态机 + 异常表
- [ ] 5. 拆模块并写模块说明（标注复用点）
- [ ] 6. 设计 ER + 表结构 + 枚举 + schema.sql 草稿
- [ ] 7. 设计 REST 接口 + 前后端类型映射
- [ ] 8. 对照 checklist 自检，补术语表与待决事项
```

### 步骤要点

**§1 需求描述**

- 1.1 必须含：业务背景、设计目标（可量化）、**非目标 Out of Scope**
- 1.4 核心场景用表格：场景 ID | 角色 | 前置条件 | 操作步骤 | 预期结果
- 1.6 验收标准用 Given-When-Then
- 1.7 PRD 与 UX 冲突时写「设计决策」列，明确跟 PRD / UX / 详细设计

**§2 流程图**

- 至少 4 块：用户主流程、后台/定时 sequence、核心实体状态机、异常分支表
- 异常表列：分支 | 触发条件 | 处理 | 用户提示

**§3 功能拆分**

- 3.1 用目录树列出前后端文件路径（`ai-video-web` / `ai-video`）
- 3.2 模块清单含：模块 ID、职责、前后端标记、优先级
- 3.3 核心模块用表格展开（职责、入参、复用、跳转/集成点）
- 3.4 任务排期含依赖关系

**§4 数据库设计**

- 约定：逻辑关联不建物理外键；`schema.sql` **仅末尾追加**；字段 COMMENT 与表结构表一致
- ER 图实体用物理表名；字段含中文注释
- 每张表：字段表（字段含义 | 类型 | 必填 | 业务说明）+ 索引说明
- 4.5 给出 schema.sql 追加块草稿（幂等 `IF NOT EXISTS`）

**§5 接口设计**

- 响应统一 `Result<T>`；异常 `BizException(ErrorCode.xxx)`
- 每个 API：请求示例、Query/Body 参数表、响应字段表、错误码表
- 复杂 API 单独写后端逻辑步骤（编号列表）
- 5.3 映射后端 VO ↔ 前端 `@types/` 文件

**§6 附录**

- 术语表：业务用语、前后端差异用语（如 PRD「做同款」vs UX「复刻」）
- 风险与待决：OQ（待决）、R（风险），含影响与状态

## 项目约束（写入 1.5 或相关章节）

| 层级 | 约束 |
| --- | --- |
| 后端 | Spring Boot 2.7 + Java 17 + MyBatis + PostgreSQL |
| 前端 | Vue 3 + TS + Element Plus；类型放 `@types/`，API 放 `@api/` |
| 异常 | `BizException(ErrorCode.xxx)`，禁止裸中文错误 |
| 数据库 | 变更只追加 `ai-video/schema.sql` 末尾，带日期分隔注释 |
| API 文档 | 实现后可通过 `:8082/doc.html` 查看 |

## 质量自检清单

生成完成后逐项核对：

- [ ] 六章齐全，章节编号与 template 一致
- [ ] Out of Scope 明确，避免范围蔓延
- [ ] 每个 P0 需求在模块清单和接口总览中有对应项
- [ ] 流程图覆盖登录/权限/异常等关键分支
- [ ] 数据库字段与 ER 图、schema 草稿三者一致
- [ ] 枚举在 4.3 定义且接口/前端有映射说明
- [ ] PRD/UX 差异已决策，无静默矛盾
- [ ] 复用点已标注（现有 Service、Util、表）
- [ ] 待决事项(OQ)与风险(R)已列出，未假装已决

## 参考资源

- **完整章节模板**：[template.md](template.md) — 生成时复制骨架再填充
- **范例文档**：`开发计划/抖音爆款库-详细设计.md` — 写法与粒度参照，勿复制业务内容
