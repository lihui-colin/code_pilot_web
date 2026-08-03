# 实施契约

本文档是 Terminal Web 运行时行为的唯一权威来源。产品文档和实施计划中的示例若与本文冲突，以本文和已验证的自动化测试为准。

## 1. 版本与外部进程

### 1.1 版本基线

- Node.js：`26.x`（当前验证版本 `26.5.1`）。
- Zellij：`0.44.3`。
- code-viewer：`0.10.0`。

启动时检查实际版本。版本不匹配时，进程可以启动并提供 `/api/health`，但 `/api/ready` 返回 `503`，所有写操作被拒绝。

code-viewer 以固定生产依赖 `@youtyan/code-viewer@0.10.0` 写入 `package.json` 和锁文件，由 `npm install` 自动安装。管理服务必须解析并使用项目本地包中的 `dist/code-viewer.js`，版本检查和实例启动使用同一文件，不依赖全局安装或 PATH 中的同名命令。

Zellij `0.44.3` 同时作为项目管理的固定二进制依赖：

1. `npm install` 的 `postinstall` 与管理服务启动都先检查配置的项目托管路径，再检查 PATH 中的 `zellij`。
2. 任一位置存在版本精确为 `0.44.3` 的 Zellij 时直接复用，不重复下载。
3. 两处都不存在可执行的 Zellij 时，从 Zellij 官方 GitHub Release 下载与当前操作系统、CPU 架构匹配的 `0.44.3` 归档，验证解压后程序的版本，并以 `0755` 原子安装到项目托管路径。
4. 已安装但版本错误时不得静默替换，仍按版本不匹配处理并由 ready 报告失败。

固定下载源不得由前端或运行时请求修改。当前支持 Linux/macOS 的 x64 与 arm64 官方归档。下载、解压或版本验证失败时，依赖安装或首次启动失败，不得执行未验证的二进制。

### 1.2 命令执行

所有外部命令必须使用 `execFile()` 或 `spawn()` 加参数数组，并设置 `shell: false`。

禁止：

- 拼接 Shell 命令。
- 接收前端提供的可执行文件、参数、环境变量或 KDL。
- 把用户输入写入未转义的命令文本。
- 将原始 stdout 或 stderr 返回前端。

Zellij 查询、创建、删除默认超时分别为 5 秒、15 秒和 15 秒。超时后终止命令进程。

### 1.3 HTTPS 监听与访问边界

管理服务提供 HTTPS，可以把 `listenHost` 配置为具体 IP 或 `0.0.0.0`。使用 `0.0.0.0` 时，`publicBaseUrl` 必须填写浏览器实际访问的 HTTPS IP 或域名，不得使用通配地址生成前端 URL。

启动脚本必须在构建和拉起进程前检查 PID 文件与配置的 `listenHost:listenPort`。本项目服务已在运行、PID 文件指向其他存活进程，或管理端口已被占用时，启动脚本必须以非零状态退出，且不得覆盖 PID 文件或启动新服务进程。

管理应用不设置用户名、密码、Basic Auth、Bearer Token 或登录页面。页面、API 和后续 viewer 代理在 VPN/公司内网边界内通过 HTTPS 访问，并复用 Zellij Web 证书和私钥。

`publicBaseUrl` 和 `zellijWebBaseUrl` 必须为 HTTPS，并使用相同主机名或 IP。Zellij Web 的登录 Cookie 为 `Secure; SameSite=Strict`，同主机 HTTPS 入口确保从管理页面打开 Session 时能够复用 Remember me 登录。两者都不得包含查询参数、片段或应用路径，也不得使用 `0.0.0.0` 或 `[::]` 作为浏览器地址。配置中的文件路径相对配置文件所在目录解析。

配置必须提供项目托管 Zellij 二进制路径、Zellij 默认 `config.kdl` 路径、Zellij Web 证书路径和私钥路径。管理服务启动时先确认 `config.kdl` 是普通文件，并在顶层原子补充或修正 `web_sharing "on"`，同时保留原文件权限。这样之后通过普通 `zellij --session <name>` 创建的新 Session 会允许运行中的 Zellij Web 附加。

`web_sharing` 是 Session 创建时读取的选项，不会追溯修改已经运行的 Session。启用前创建且未主动共享的 Session 需要停止后用相同命令重新创建；管理服务不得为此自动删除现有 Session。

初始化脚本在网络依赖安装之前按下述规则创建证书。未运行初始化脚本时，管理服务首次启动执行相同的创建和校验规则：

1. 证书和私钥都存在时，确认两者为非空普通文件、私钥不允许 group/other 访问、证书未过期且公钥匹配，然后直接复用。
2. 两者都不存在时，通过参数数组调用 `openssl` 创建十年期 RSA-2048/SHA-256 自签名证书；SAN 至少包含 `localhost`、`127.0.0.1` 和 `zellijWebBaseUrl` 的主机。证书权限为 `0644`，私钥权限为 `0600`。
3. 只存在其中一个、文件无效、已过期、密钥不匹配或权限不安全时启动失败，不得覆盖现有文件。

Zellij Web 的独立服务配置必须把 `web_server_cert` 和 `web_server_key` 指向上述文件。

Zellij Web Token 初始化和管理遵循：

1. `zellij.webToken` 同时保存 Token 的 `name` 和 `value`；配置文件权限必须为 `0600`。
2. 配置必须提供固定 Zellij `0.44.3` 的 Token SQLite 文件路径。首次启动时若配置没有 Token，先调用 `web --list-tokens` 初始化并验证数据库，然后使用 Node.js SQLite API创建随机唯一名称和 UUID 值，只把 SHA-256 Token 哈希、名称和只读标志写入 Zellij 的 `tokens` 表；明文名称和值随后原子写入应用配置。数据库权限必须为 `0600`。
3. 不使用 Zellij `0.44.3` 的 `web --create-token`：该版本把 `--create-token` 错误声明为 exclusive，无法配合 `--token-name`；默认名称又使用 `token_<当前记录数+1>`，撤销历史 Token 后可能与已有名称冲突。
4. 配置已有 Token 时，通过 `web --list-tokens` 确认名称仍存在；名称已被撤销时自动创建并保存替代 Token。
5. 重新创建时先创建并保存新名称和值，再使用旧名称调用 `web --revoke-token <old-name>`，避免创建失败导致无可用 Token。
6. 删除时使用配置保存的名称撤销 Token，并从配置删除名称和值。
7. Token 值只能出现在受 VPN/内网保护的专用只读 API 和主页 Token 区域；普通日志、错误响应和其他 API 不得包含 Token。

公开端口必须通过主机防火墙限制在 VPN/公司内网网段。写请求仍需校验 `Origin`，目录与命令边界不因取消登录或 TLS 而放宽。

### 1.4 健康和就绪接口

```http
GET /api/health
GET /api/ready
```

两个接口都不要求用户名或密码。`health` 只报告管理进程存活，不调用外部工具。`ready` 返回 Node.js、Zellij、code-viewer、工作目录和目录 ID secret 的布尔检查结果；任一检查失败时返回 `503`，且不得包含绝对路径或原始命令输出。

## 2. Session 契约

### 2.1 类型

```typescript
type SessionStatus = "running";
type SessionOrigin = "managed" | "external";

interface SessionInfo {
  name: string;
  status: SessionStatus;
  origin: SessionOrigin;
  repositoryId: string | null;
  relativePath: string | null;
  createdAt: string | null;
  command: string | null;
  webUrl: string;
}

interface CreateSessionRequest {
  repositoryId: string;
  command: "codex";
}
```

请求拒绝额外字段，前端不得提交 Session 名称。服务端把 repository 目录名中的非 `A-Za-z0-9_-` 字符替换为 `-` 并截断到 64 字符，作为固定 Session 名称；这与旧页面的默认名称兼容。同一扫描结果存在相同基础名称时，服务端为这些条目追加 directory ID 的 8 字符短后缀，并相应截断基础名称。生成结果必须匹配 `^[A-Za-z0-9_-]{1,64}$`，同一个 repository 跨服务重启保持一致。

### 2.2 查询

使用参数数组：

```typescript
["list-sessions", "--short"]
```

每一行只解析为 Session 名称，不解析 `--no-formatting` 的相对时间文本。输出中不符合名称规则的行忽略并记录 warning。

Session 出现在结果中即为 `running`。MVP 不探测 Session 内 Codex 是否仍在运行。

管理服务创建且元数据存在的 Session 为 `managed`；其他 Session 为 `external`。外部 Session 的 `repositoryId`、`relativePath`、`createdAt` 和 `command` 为 `null`。repository 列表仍通过服务端生成的固定 Session 名称识别对应 Session，因此管理服务重启后可以继续在 repository 条目上打开或删除该 Session。

`GET /api/sessions` 只返回当前存在的 Session，按名称字节序升序排列。

### 2.3 创建

创建前必须：

1. 校验请求 schema，并根据 repositoryId 生成固定 Session 名称。
2. 根据 repositoryId 重新解析目录并执行真实路径边界校验。
3. 重新确认目录仍为 repository。
4. 查询当前 Session；固定名称已存在时直接返回已有 Session，不执行创建命令。
5. 获取基于 Session 名称的进程内互斥锁。

`command` 只映射到服务端预定义 KDL layout。layout 临时文件位于 `data/layouts/`，权限为 `0600`，成功或失败后都在 `finally` 中删除。

目录路径不插入 KDL 字符串。目标目录由 `--default-cwd` 设置。创建参数数组为：

```typescript
[
  "--layout",
  layoutPath,
  "attach",
  "--create-background",
  sessionName,
  "options",
  "--default-cwd",
  realPath
]
```

命令成功后再次执行 `list-sessions --short`。只有精确匹配名称才算创建成功，然后写入 managed Session 元数据。

新建成功返回 `201`。固定名称已经存在或并发请求已经完成创建时返回已有 Session 和 `200`，不得再次执行创建命令，也不得创建第二个对应 Session。

### 2.4 删除

删除前校验名称、获取同名互斥锁并确认 Session 存在。删除参数数组为：

```typescript
["delete-session", "--force", sessionName]
```

删除后再次查询，只有名称确实消失才删除 managed 元数据并返回成功。删除不存在的名称返回 `404 SESSION_NOT_FOUND`。

管理服务停止时不得删除 Session。

### 2.5 Web URL

`zellijWebBaseUrl` 必须是 HTTPS URL，启动时使用标准 `URL` 解析，且不得包含查询参数、片段或 Session 路径。

Session URL 由服务端生成：

```typescript
new URL(`${encodeURIComponent(name)}`, `${baseUrl}/`).toString()
```

前端不得自行拼接主机或端口。

## 3. 目录契约

### 3.1 类型和接口

```typescript
type ProjectKind = "directory" | "repository";
type ProjectMarker = "git" | "node" | "python" | "rust" | "go" | "java";

interface DirectoryEntry {
  id: string;
  name: string;
  relativePath: string;
  kind: ProjectKind;
  markers: ProjectMarker[];
  viewer: {
    id: string;
    status: ViewerStatus;
    webUrl: string;
  } | null;
  session: {
    name: string;
    status: SessionStatus;
    webUrl: string;
  } | null;
}

interface RepositoryListing {
  current: {
    id: string | null;
    name: string;
    relativePath: string;
  };
  breadcrumbs: Array<{
    id: string | null;
    name: string;
    relativePath: string;
  }>;
  entries: DirectoryEntry[];
}
```

接口为：

```http
GET /api/repositories
```

接口不接受 `parentId`、路径或其他查询参数。服务端递归发现 repository，但前端仍以单一扁平列表展示，不提供目录导航。每个条目的 `session` 通过固定 repository Session 名称与当前 Zellij Session 列表匹配；不存在时为 `null`。

### 3.2 工作目录

服务启动时必须接收 `--workspace-root`，并执行 `realpath()`。目录必须存在、可读且为目录，否则启动失败。

保存规范化后的 `workspaceRootRealPath`。不得回退到当前目录、用户主目录或服务器根目录。

### 3.3 目录 ID

目录 ID 为：

```text
dir_<base64url(HMAC-SHA256(directoryIdSecret, normalizedRelativePath))>
```

`directoryIdSecret` 从持久化 secret 文件读取。文件缺失、不可读或权限过宽时服务拒绝 ready。重启后 secret 必须保持不变。

API 不从 ID 反解路径。RepositoryService 只为返回的 Git repository 登记 `id -> normalizedRelativePath` 索引。未知或失效 ID 返回 `404 DIRECTORY_NOT_FOUND`。

### 3.4 真实路径边界

每次列 repository、创建 Session 或启动 viewer 时都必须重新校验：

1. 从工作目录和已登记相对路径构造候选路径。
2. 对候选路径执行 `realpath()`。
3. 计算 `path.relative(workspaceRootRealPath, targetRealPath)`。
4. 仅当结果不是 `..`、不以 `../` 开头且不是绝对路径时通过。

工作目录自身允许作为根节点。指向根目录外部的符号链接不得出现在结果中。

断链、无权限或扫描期间消失的递归扫描条目跳过并记录 warning。workspace 不存在时返回 `404 DIRECTORY_NOT_FOUND`。

### 3.5 扫描与识别

每次请求先重新校验 workspace 根目录，并按以下顺序处理：

1. 若 workspace 自身包含 `.git` 文件或目录，则只返回 workspace 自身，且不得读取或探测任何子目录。
2. 若 workspace 自身不是 Git repository，则从 workspace 开始递归扫描可见目录，返回任意深度包含 `.git` 文件或目录的 Git repository。
3. 一旦某个目录被识别为 Git repository，将其加入结果并停止深入该 repository；普通容器目录继续递归。
4. 使用真实路径集合避免符号链接循环；指向 workspace 外部的符号链接跳过。
5. 结果以扁平列表返回，不提供面包屑导航操作。

默认隐藏名称以 `.` 开头的目录，但 `.git` 用于识别 repository。默认忽略：

```text
node_modules
target
dist
build
vendor
.cache
```

Git repository 的唯一准入标识为 `.git` 文件或目录。其他 marker 只作为已返回 Git repository 的技术栈元数据：

| 文件 | marker |
| --- | --- |
| `.git` | `git` |
| `package.json` | `node` |
| `pyproject.toml` | `python` |
| `Cargo.toml` | `rust` |
| `go.mod` | `go` |
| `pom.xml` | `java` |

只有包含 `.git` 才返回为 repository；仅包含 `package.json`、`pyproject.toml`、`Cargo.toml`、`go.mod` 或 `pom.xml` 的目录不得返回。`markers` 按 `git,node,python,rust,go,java` 固定顺序返回。

返回条目全部为 repository，按 `relativePath` 字节序升序排列。workspace 自身作为 repository 返回时，`relativePath` 为 `""`。

当 workspace 不是 Git repository 时，单次递归扫描最多检查 1000 个可见目录，超过返回 `422 DIRECTORY_TOO_LARGE`，不得静默截断。单次扫描超时 5 秒。

## 4. Viewer 契约

### 4.1 类型

```typescript
type ViewerStatus = "starting" | "running" | "stopping" | "failed";

interface ViewerInstance {
  id: string;
  repositoryId: string;
  pid: number;
  upstreamUrl: string;
  webUrl: string;
  createdAt: string;
  lastAccessedAt: string;
  status: ViewerStatus;
}

interface CreateViewerRequest {
  repositoryId: string;
}
```

请求拒绝额外字段。API 不返回真实路径，日志默认只记录相对路径。

Viewer ID 使用 128 位加密安全随机数的 base64url 表示，并加 `viewer_` 前缀。ID 不得由目录 ID或路径推导。

### 4.2 启动

启动前重新解析 repositoryId，执行路径边界校验并确认仍为 repository。

同一 repositoryId 使用启动锁。并发 `POST /api/viewers` 等待同一个启动 Promise，并返回同一个实例。

已有健康实例时复用并返回 `200`。创建新实例返回 `201`。已有记录但健康检查失败时先清理，再创建。

code-viewer 只监听 `127.0.0.1`。当前配置使用 `8022` 作为其 localhost 上游端口，并通过管理服务同源 `/viewer/<viewer_id>/` 地址访问；上游端口不得作为浏览器地址返回。由于 code-viewer `0.10.0` 使用根绝对资源路径，当前兼容实现同一时刻只保留一个活动实例，切换仓库时先停止旧实例。启动参数数组为：

```typescript
["--cwd", realPath, "--port", String(port)]
```

进程使用独立 process group。每个实例最多保留 stdout 和 stderr 的最后 64 KiB，不能返回前端。

解析 `GDP_LISTEN_URL` 仅用于校验实际地址等于：

```text
http://127.0.0.1:<allocated-port>
```

端口占用时释放记录并最多重试两个其他端口。仍失败返回 `502 VIEWER_START_FAILED`。

### 4.3 健康和停止

健康检查访问上游 `/`，接受 `200-399`。每 200 毫秒重试一次，总超时 15 秒。

启动超时或失败时终止进程组并释放端口。

停止时先发送 `SIGTERM`，等待 5 秒；仍存活则发送 `SIGKILL`。停止期间同目录的新启动请求返回 `409 VIEWER_STOPPING`。

进程 `exit` 或 `error` 时清理实例和端口状态。

当前单实例兼容模式最多运行一个实例；配置中的空闲回收和并发上限字段为后续多实例管理保留。

### 4.4 同源代理

外部入口固定为：

```text
/viewer/<viewer_id>/
```

当前单实例兼容代理必须：

- 在首次访问时移除 `/viewer/<viewer_id>` 前缀并代理到上游 `/`。
- 设置仅 HttpOnly、SameSite=Strict 的当前 viewer ID cookie。
- 依据该 cookie 把 code-viewer 后续根绝对资源、导航、API 和 `/events` SSE 请求转发到当前活动实例。
- 保留管理首页 `/`、管理 API 和管理前端已登记静态资源的原有路由。
- 重写上游 `Host`、`Origin` 和 `Referer`，不修改 HTML、CSS 或 JavaScript 正文。
- 使用成熟代理库流式转发响应，并在成功请求时更新 `lastAccessedAt`。

只有 `running` 实例可以代理，其他状态返回 `503 VIEWER_NOT_READY`。

API 和 viewer 代理均不要求应用层登录。上游端口不得监听公网地址或加入防火墙允许列表。

不得自动改为公开端口池。通用多实例限制见 [ADR-002](decisions/002-viewer-proxy.md)，当前兼容结构见 [ADR-004](decisions/004-single-viewer-compatibility-proxy.md)。

## 5. API 契约

### 5.1 路由

| 方法 | 路径 | 成功状态 | 作用 |
| --- | --- | --- | --- |
| `GET` | `/api/health` | `200` | 进程存活 |
| `GET` | `/api/ready` | `200` 或 `503` | 依赖就绪状态 |
| `GET` | `/api/sessions` | `200` | Session 列表 |
| `POST` | `/api/sessions` | `200` 或 `201` | 复用或创建 repository 对应 Session |
| `DELETE` | `/api/sessions/:name` | `204` | 删除 Session |
| `GET` | `/api/repositories` | `200` | 浏览目录 |
| `GET` | `/api/zellij-token` | `200` | 读取主页展示的 Zellij Web Token 名称和值 |
| `POST` | `/api/zellij-token/regenerate` | `201` | 创建或重新创建 Zellij Web Token |
| `DELETE` | `/api/zellij-token` | `204` | 撤销并删除当前 Zellij Web Token |
| `GET` | `/api/viewers` | `200` | 当前进程的 viewer 列表 |
| `POST` | `/api/viewers` | `200` 或 `201` | 复用或创建 viewer |
| `DELETE` | `/api/viewers/:id` | `204` | 停止 viewer |

`DELETE` 请求不接受请求体。`GET /api/viewers` 按 `createdAt` 升序返回。

### 5.2 错误响应

```typescript
interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}
```

状态码语义：

- `400`：schema、查询参数、名称或 ID 格式错误。
- `403`：无权限或写请求 Origin 非同源。
- `404`：资源不存在。
- `409`：资源状态冲突。
- `422`：目录不是 repository 或目录规模超过限制。
- `429`：实例数量或启动频率超过限制。
- `500`：管理服务内部或状态写入失败。
- `502`：Zellij 或 code-viewer 执行失败。
- `504`：外部命令或健康检查超时。

每个请求生成 `requestId`。错误消息不得包含绝对路径、Token、环境变量、原始命令输出或堆栈。

Fastify 为请求、查询和响应配置 schema；Zod 定义共享领域类型。请求体上限为 64 KiB。

### 5.3 健康与就绪

`GET /api/health` 只表示管理进程存活，不调用外部工具。

`GET /api/ready` 检查：

- 工作目录可读。
- 状态文件可读且 schema 有效。
- directory ID secret 可用。
- Zellij CLI 版本正确。
- code-viewer CLI 版本正确。
- Zellij Web 可达。

关键依赖失败时返回 `503` 和不含敏感细节的组件状态，并禁止写操作。

## 6. 访问控制契约

管理应用不提供应用层认证，不要求用户名、密码、Bearer Token 或登录 Cookie，也不提供 `/api/me`。

页面、API 和 viewer 代理必须同源 HTTPS。Zellij Web 使用同主机、不同端口的 HTTPS 入口。所有写请求的 `Origin` 必须等于 `publicBaseUrl`。

访问控制由 VPN/公司内网和主机防火墙承担。公开管理端口和 Zellij Web 端口只允许受控网段访问；code-viewer 上游端口只监听 localhost。

Zellij Web 保留自身 Token 验证。管理服务按第 1.3 节保存和管理专用 Zellij Web Token，并只通过主页专用接口展示。Token 管理写请求必须执行同源 Origin 校验。

取消应用登录不改变目录 containment、命令允许列表、请求 schema、实例限制、审计日志或错误脱敏要求。

## 7. 状态契约

### 7.1 文件

状态文件固定为 `data/state.json`：

```json
{
  "version": 1,
  "sessions": [],
  "viewers": []
}
```

`data/` 权限为 `0700`，状态文件权限为 `0600`。JSON 使用两个空格缩进并以换行结尾。

文件不存在表示首次启动。JSON 损坏、schema 不合法或版本高于当前程序时保留原文件，ready 返回失败并禁止写操作。

### 7.2 原子写入

状态更新在进程内串行执行：

1. 写入同目录临时文件。
2. 设置权限 `0600`。
3. 对文件执行 `fsync`。
4. 原子 rename 替换正式文件。
5. 对父目录执行 `fsync`。

状态写入是写操作成功的一部分。外部操作成功但写入失败时返回 `500 STATE_WRITE_FAILED`，记录高优先级日志，并重新查询真实状态进行补偿。

状态文件保存 managed Session 元数据和 viewer 清理元数据，不保存 Token、命令输出或其他秘密。

### 7.3 恢复与退出

启动时通过 Zellij CLI 恢复真实 Session 集合，并合并 managed 元数据。状态文件中存在但真实 Zellij 集合中已不存在的 Session 记录必须删除并原子写回；若启动时无法查询 Zellij，则保留原记录，不得猜测删除。

首版不接管历史 viewer。历史 PID 只在同时验证命令和启动时间属于本服务时终止，随后清空 viewer 和端口记录。用户下次访问时重新创建。

收到 `SIGTERM` 时：

1. 停止接受新请求。
2. 最多等待 10 秒完成进行中的请求和状态写入。
3. 停止所有当前管理的 viewer 进程组。
4. 不删除 Zellij Session。

理由见 [ADR-003](decisions/003-state-recovery.md)。

## 8. 前端契约

- 每个 repository 只对应一个由服务端命名的 Session，前端不要求用户输入 Session 名称。
- repository 没有对应 Session 时显示创建操作；创建成功后刷新 Session 和 repository 列表，不自动打开新标签页。
- repository 已有对应 Session 时显示后端返回的 Zellij Web 打开链接和删除操作。
- 点击浏览时同步执行 `window.open("about:blank", "_blank")`。
- `window.open()` 返回 `null` 时不发送 viewer 启动请求，并提示允许弹窗。
- viewer 启动失败时关闭空白页。
- 打开链接使用后端 URL，设置 `target="_blank"` 和 `rel="noopener noreferrer"`。
- 删除 Session 要求用户输入准确名称确认。
- 只读列表每 10 秒刷新；页面不可见时暂停，恢复可见时立即刷新。
- 轮询不得覆盖本地 `starting`、`stopping` 或删除中状态。
- 相对路径只作为文本渲染，不使用 `dangerouslySetInnerHTML`。
- viewer URL 不持久化到 localStorage。
- 主页明确显示 Zellij Web Token 名称和值，并提供复制、删除和重新创建操作。
- 删除和重新创建 Token 必须二次确认；Token 操作完成后立即更新页面状态。
