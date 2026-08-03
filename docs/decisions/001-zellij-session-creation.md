# ADR-001：Zellij Session 创建方式

- 状态：Accepted
- 日期：2026-08-02

## 背景

管理 API 必须在不附加交互终端的情况下创建 Zellij Session，并在指定 repository 中启动服务端允许的命令。

Zellij `0.44.3` 已确认支持 `attach --create-background`。直接运行 `zellij --session <name>` 会进入交互客户端，不适合 HTTP 请求生命周期。

## 决策

使用 `zellij attach --create-background` 创建 detached Session，并通过服务端生成的临时 KDL layout 启动允许命令。

目标目录通过 `options --default-cwd <realPath>` 传入。前端只提交 command 标识，首个标识为 `codex`。

创建后必须执行 `list-sessions --short` 精确确认 Session 存在。删除使用 `delete-session --force <name>`，删除后再次确认名称消失。

## 后果

- HTTP 请求不会被交互客户端阻塞。
- 任意命令和参数不会进入服务端。
- 需要维护版本固定的 KDL layout 模板。
- 必须安全创建和清理权限为 `0600` 的临时 layout 文件。
- Session 内命令状态与 Session 存在状态是不同概念，MVP 只报告后者。
