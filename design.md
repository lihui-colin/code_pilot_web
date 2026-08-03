# Terminal Web 设计文档

本文件只作为设计入口，不再承载完整实施细节。这样 Codex 在执行单个任务时可以只读取相关文档，避免重复描述和过量上下文。

## 文档导航

- [产品需求](docs/requirements.md)：目标体验、页面行为、总体架构和安全边界。
- [实施契约](docs/contracts.md)：API、类型、目录安全、外部进程、代理、认证和状态生命周期。代码行为以此文档为准。
- [实施计划](docs/implementation.md)：技术选型、目录结构、阶段顺序和里程碑。
- [测试计划](docs/testing.md)：服务端边界测试、集成测试和前端验收。
- [架构决策](docs/decisions/)：关键选择及其原因。
- [Codex 工作入口](AGENTS.md)：每次编码都需要遵守的最小规则和当前阶段。

## 阅读方式

进行具体开发任务时不要默认读取全部文档：

1. 先读取 [AGENTS.md](AGENTS.md)。
2. 根据任务读取一份主要文档。
3. 只有涉及跨模块契约或决策依据时，再读取关联文档。

例如，实现目录浏览时读取 `AGENTS.md`、`docs/contracts.md` 中的目录契约和 `docs/testing.md` 中的目录测试，不需要加载 Session 与 viewer 的全部背景。

## 权威顺序

发生描述冲突时，按以下顺序处理：

1. 已验证的外部工具行为和自动化测试。
2. `docs/contracts.md`。
3. `docs/decisions/` 中状态为 Accepted 的决策。
4. `docs/requirements.md`。
5. `docs/implementation.md` 中的示例。

任何运行时契约变更必须同步更新测试和相关架构决策。
