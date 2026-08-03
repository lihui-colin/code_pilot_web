# 实施计划

## 技术选型

使用一个 Node.js 26 和 TypeScript 应用提供管理 API、前端静态资源、子进程管理和 code-viewer 代理。

- 后端：Fastify。
- 前端：React + Vite。
- 输入和配置校验：Zod。
- 日志：Pino。
- 状态存储：可读 JSON 文件。
- 测试：Vitest。
- 外部进程：Node.js `execFile()` 和 `spawn()`。
- code-viewer：项目生产依赖 `@youtyan/code-viewer@0.10.0`，由 `npm install` 安装并从本地包路径启动。
- HTTP/SSE 代理：Fastify 官方 `@fastify/reply-from`，不扩展手写代理。

运行时行为必须遵守 [实施契约](contracts.md)。

## 目标目录结构

```text
terminal_web/
|-- AGENTS.md
|-- package.json
|-- tsconfig.json
|-- config.example.json
|-- data/
|   |-- directory-id.secret
|   `-- state.json
|-- docs/
|   |-- requirements.md
|   |-- contracts.md
|   |-- implementation.md
|   |-- testing.md
|   `-- decisions/
|-- src/
|   |-- server.ts
|   |-- config.ts
|   |-- domain/
|   |   `-- types.ts
|   |-- routes/
|   |   |-- sessions.ts
|   |   |-- repositories.ts
|   |   |-- viewers.ts
|   |   |-- health.ts
|   |   `-- ready.ts
|   |-- services/
|   |   |-- zellij-service.ts
|   |   |-- repository-service.ts
|   |   |-- viewer-manager.ts
|   |   |-- viewer-proxy.ts
|   |   `-- audit-service.ts
|   |-- state/
|   |   `-- state-store.ts
|   `-- web/
|       |-- App.tsx
|       |-- api.ts
|       `-- components/
|-- tests/
|   |-- repository-service.test.ts
|   |-- zellij-service.test.ts
|   |-- viewer-manager.test.ts
|   `-- integration/
`-- deploy/
    |-- terminal-web.service
    `-- zellij-web.service
```

## 配置示例

工作目录不写入 JSON 配置，只通过 `--workspace-root` 传入。

```json
{
  "listenHost": "0.0.0.0",
  "listenPort": 8024,
  "publicBaseUrl": "https://192.0.2.10:8024",
  "zellijWebBaseUrl": "https://192.0.2.10:8021",
  "zellij": {
    "managedBinaryFile": "data/bin/zellij",
    "configFile": "/home/user/.config/zellij/config.kdl",
    "webTokenDatabaseFile": "/home/user/.local/share/zellij/tokens.db",
    "webCertificateFile": "data/zellij/certs/cert.pem",
    "webPrivateKeyFile": "data/zellij/certs/key.pem"
  },
  "directoryIdSecretFile": "data/directory-id.secret",
  "viewerPortRange": {
    "start": 8022,
    "end": 8022
  },
  "viewerIdleTimeoutMinutes": 60,
  "viewerMaxInstances": 1,
  "projectMarkers": [
    ".git",
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "pom.xml"
  ],
  "allowedSessionCommands": [
    "codex"
  ]
}
```

## MVP-0：外部工具验证

已确认：

- Zellij `0.44.3` 支持 `attach --create-background`。
- Zellij `0.44.3` 支持 `list-sessions --short`。
- Zellij `0.44.3` 支持 `delete-session --force`。
- code-viewer `0.10.0` 支持 `--cwd` 和 `--port`。
- 临时 KDL layout 可以后台创建 Session，且允许命令在 `--default-cwd` 指定目录启动。
- Zellij Web 的 Session URL 为 `/<encoded-session-name>`。
- 默认 Zellij 配置启用 `web_sharing "on"` 后，通过交互命令 `zellij --session <name>` 创建的新 Session 可以由 Zellij Web WebSocket 客户端附加。
- code-viewer 的 `GDP_LISTEN_URL` 与显式 localhost 端口一致，根路径返回 `200`。
- 前缀移除代理可以传输静态资源、SSE、Location 和 Cookie，但 code-viewer `0.10.0` 的 HTML 包含根绝对 URL，浏览器会逃出 `/viewer/<id>/`。
- code-viewer `0.10.0` 使用 SSE `/events`，没有可验证的 WebSocket endpoint。

结论：MVP-0 的 Zellij 与健康检查验证已完成；通用多实例子路径模型未通过。当前按单活动实例兼容模式实现：code-viewer 仍只监听 localhost:8022，首次入口使用实例前缀，后续根绝对请求通过仅 HttpOnly viewer cookie 路由到当前实例。代理不改写响应正文，上游端口不直接公开到 VPN 网络。

### MVP-0 验证状态（2026-08-02）

使用 `scripts/probe-mvp0.mjs` 对固定版本执行真实集成探测：

- 通过：Node.js `26.x`、Zellij `0.44.3` 和 code-viewer `0.10.0` 版本基线。
- 通过：临时 KDL layout 后台创建 Session，允许命令在目标目录启动，精确查询和仅删除目标 Session。
- 通过：运行中的 Zellij Web 可通过编码后的 Session 路径返回页面。
- 通过：code-viewer 显式 localhost 端口、`GDP_LISTEN_URL` 和根路径健康检查。
- 通过：显式加上实例前缀的静态资源请求和 `/events` Server-Sent Events 流可由去前缀代理转发。
- 阻塞：code-viewer `0.10.0` HTML 使用根绝对资源和导航 URL，浏览器会从 `/viewer/<id>/` 逃逸到站点根路径。
- 阻塞：code-viewer `0.10.0` 使用 Server-Sent Events，未提供可探测的 WebSocket endpoint，无法满足当前 MVP-0 WebSocket 验收项。

因此通用多实例子路径代理仍未通过；当前只交付满足仓库“浏览代码”按钮的单实例兼容代理，不把 localhost 上游端口作为浏览器入口。

## MVP-1：只读管理

当前进度：首版已实现项目脚手架、Node 26 构建、无用户凭据的直接 HTTPS/IP 监听、项目托管 Zellij 首次安装、Zellij Web 证书和 Token 初始化、Token 主页管理、健康/就绪、Session 查询、目录浏览和响应式页面。

实施范围：

- 项目脚手架、构建和配置加载。
- 默认 Zellij `config.kdl` 的 Web Sharing 初始化。
- `--workspace-root` 启动校验。
- 无用户凭据的同源 HTTPS 部署入口。
- `GET /api/health`。
- `GET /api/ready`。
- `GET /api/sessions`。
- `GET /api/repositories`。
- 只读管理页面、目录导航和 Session 打开链接。

验收条件：访问管理入口的用户可以查看当前 Zellij Session；workspace 自身为 Git repository 时只显示自身，否则递归发现任意深度的 Git repository 并以扁平列表显示。

## MVP-2：Session 操作

实施范围：

- managed Session 元数据存储。
- `POST /api/sessions`。
- `DELETE /api/sessions/:name`。
- repository ID 到固定 Session 名称的服务端映射，以及 repository 列表中的 Session 状态。
- KDL layout 生成和允许命令映射。
- 创建、删除互斥和超时。
- 创建对话框和删除确认。
- 审计事件基础结构。

验收条件：每个 Git repository 最多对应一个固定 Session；不存在时创建，存在时直接打开，并可安全删除目标 Session。

## MVP-3：代码浏览

实施范围：

- 单活动 code-viewer 的固定 localhost 端口、启动锁、健康检查和停止。
- `GET /api/viewers`。
- `POST /api/viewers`。
- `DELETE /api/viewers/:id`。
- 实例入口前缀与 HttpOnly viewer cookie 组成的同源 HTTP/SSE 兼容代理。
- 异常退出清理和空白标签页交互。

验收条件：同一目录的并发请求只产生一个实例；切换目录先停止旧实例；浏览器可以通过同源代理浏览代码和接收 SSE 更新。

## MVP-4：生产化

实施范围：

- 空闲回收、实例上限和启动频率限制。
- JSON 状态恢复和异常状态处理。
- 公司统一认证、权限审计和完整审计日志。
- systemd 服务、固定版本和防火墙规则。
- 优雅退出、请求排空和 viewer 进程组清理。

验收条件：服务可长期运行并在主机重启后自动启动，不产生失控 viewer，只有 VPN 内授权用户能够操作。

## 实施原则

- 每次只实现当前里程碑或其必要前置条件。
- 先实现拥有行为的服务，再接路由和 UI。
- 每个外部工具集成先以可替换接口封装，单元测试使用 fake adapter。
- 目录安全校验集中在 RepositoryService，不在路由中复制。
- 状态变更必须经过 StateStore 串行写入。
- 前后端共享领域枚举和 API schema，避免手写重复字符串。
- 每个阶段完成后执行 [测试计划](testing.md) 中对应范围。

## 部署基线

systemd 服务至少设置：

```ini
[Service]
User=lihui
WorkingDirectory=/home/lihui/terminal_web
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
```

管理应用监听 `0.0.0.0:8024` 并提供 HTTPS；Zellij Web 使用同主机的 `8021`，两者复用证书；code-viewer 使用 `8022` 且上游仍只能监听 `127.0.0.1`。管理应用不设置用户或密码，防火墙必须把公开端口限制在 VPN/公司内网。文件系统沙箱必须允许读取配置的工作目录以及项目托管 Zellij 和证书目录，但不能扩大为 root 权限。
