# 实施契约

本文档是 CodePilot Web 运行时行为的唯一权威来源。产品文档和实施计划中的示例若与本文冲突，以本文和已验证的自动化测试为准。

## 1. 版本与外部进程

### 1.1 版本基线

- Node.js：`26.x`（当前验证版本 `26.5.1`）。
- Zellij：`0.44.3`。
- code-viewer：`0.10.0`。
- OpenVSCode Server：`1.109.5`。

管理服务启动时检查 Node.js、Zellij 和 code-viewer 的实际版本。版本不匹配时，进程可以启动并提供 `/api/health`，但 `/api/ready` 返回 `503`，所有写操作被拒绝。OpenVSCode 版本由 `codepilot-server init` 在初始化时验证。

code-viewer 以固定生产依赖 `@youtyan/code-viewer@0.10.0` 写入 `package.json` 和锁文件，由 `npm install` 自动安装。管理服务必须解析并使用项目本地包中的 `dist/code-viewer.js`，版本检查和实例启动使用同一文件，不依赖全局安装或 PATH 中的同名命令。

OpenVSCode Server 由 `codepilot-server init` 使用 Node.js `fetch` 从官方 GitHub Release 下载固定版本。初始化命令必须显示下载进度，按 Linux x64、arm64 或 armhf 选择官方归档，验证官方发布页固定的 SHA-256 摘要和解压后的 `bin/openvscode-server --version`，再安装到 `data/openvscode/openvscode-server-v1.109.5-linux-<arch>/`，并原子更新 `data/openvscode/current` 符号链接。初始化命令把 `current/bin/openvscode-server` 及配置端口写入 `config.json`，不得调用 Bash、curl 管道或下载后执行的安装脚本。`scripts/download-openvscode.sh` 仅保留为兼容的独立下载入口。

Zellij `0.44.3` 同时作为项目管理的固定二进制依赖：

1. 管理服务启动时先检查配置的项目托管路径，再检查 PATH 中的 `zellij`。
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

管理服务提供 HTTPS。唯一生命周期入口是 Node.js 可执行应用 `codepilot-server`，支持 `init`、`start`、`stop`、`restart`、`status` 和 `run` 子命令，不依赖 Bash 启停脚本。`codepilot-server init` 在 Node.js 26 和应用包已经安装后负责参数校验、Zellij 与 OpenVSCode 固定版本安装、目录 ID secret、HTTPS 证书、Zellij KDL 和 `config.json` 初始化；它不负责安装 Node.js、执行 `npm install`、构建应用或注册全局命令。初始化过程中外部程序只可通过 `execFile()` 参数数组调用固定的 `tar` 和 `openssl`，不得启动 shell。启动命令为 `codepilot-server start --host <browser-host> --port <port> --workspace <directory>`。管理服务默认监听 `0.0.0.0`；`--host` 表示浏览器实际访问的 IP 或域名，用于生成 `publicBaseUrl`，并作为 Zellij HTTPS 证书必须覆盖的 SAN。省略 `--host` 时沿用配置中的 `publicBaseUrl` 主机。`--host` 不接受 `0.0.0.0`、`::` 等通配地址。`--port` 和 `--workspace` 覆盖配置中的对应运行值；旧的 `--workspace-root` 参数保持兼容。

启动脚本必须在构建和拉起进程前检查 PID 文件、管理服务 `listenHost:listenPort`，以及 `viewerPortRange` 中所有 localhost code-viewer 端口。本项目服务已在运行、PID 文件指向其他存活进程，或管理服务或 code-viewer 端口已被占用时，启动脚本必须以非零状态退出，且不得覆盖 PID 文件或启动新服务进程。Zellij Web 是独立服务，其端口即使已在运行也不得阻止管理服务启动。

统一重启通过固定的 Node.js CLI `codepilot-server restart` 执行。网页只能调用不接受路径、命令、参数或环境变量的 `POST /api/services/restart`；后端只启动已安装应用自身的 `dist/cli.js restart`，并使用启动时保存且已校验的运行元数据。接口返回 `202` 后，CLI 必须：

1. 向管理服务发送 `SIGTERM`，等待其停止当前 code-viewer 和活动 Codex app-server 进程组。
2. 调用固定 Zellij CLI 的 `web --stop`，只停止 Zellij Web，不删除任何 Zellij Session。
3. 按托管进程登记、项目可执行路径、固定参数、启动时间、配置文件和端口共同验证遗留的管理服务、Codex、code-viewer、Zellij Web 与 OpenVSCode 进程身份；只终止验证通过的进程或独立进程组。
4. 删除本项目的陈旧 PID 与托管进程登记，并确认管理、viewer、Zellij Web 和 OpenVSCode 配置端口均已释放。端口属于无法验证的进程时重启失败，不得误杀或覆盖端口。
5. 使用同一 workspace root 只重新启动 Zellij Web 和管理服务，并原子重建权限为 `0600` 的对应 PID 文件。code-viewer、Codex 与 OpenVSCode 在 cleanup 后保持停止，不得由 restart 自动恢复。

网页触发的重启输出追加到 `data/codepilot-web-restart.log`。部分启动失败时必须再次执行相同的身份校验和端口清理；Zellij Session 始终保留。重启后的管理服务不得恢复重启前仍在运行的 Codex turn 或 code-viewer 实例，OpenVSCode 也保持停止；只有显式的完整 `start`/`run` 流程才确保 OpenVSCode 运行。

管理应用不设置用户名、密码、Basic Auth、Bearer Token 或登录页面。页面、API 和后续 viewer 代理在 VPN/公司内网边界内通过 HTTPS 访问，并复用 Zellij Web 证书和私钥。

`publicBaseUrl` 是唯一浏览器入口，必须使用 HTTPS，且不得包含查询参数、片段或应用路径，也不得使用 `0.0.0.0` 或 `[::]`。Zellij Web 内部端口由 `zellij.webPort` 配置并只监听 localhost，不保存或返回独立浏览器 URL。配置中的文件路径相对配置文件所在目录解析。

配置必须提供项目托管 Zellij 二进制路径、Zellij 默认 `config.kdl` 路径、Zellij Web 证书路径和私钥路径。管理服务启动时先确认 `config.kdl` 是普通文件，并在顶层原子补充或修正 `web_sharing "on"`，同时保留原文件权限。这样之后通过普通 `zellij --session <name>` 创建的新 Session 会允许运行中的 Zellij Web 附加。

配置还必须提供 `openVSCode.executableFile` 和 `openVSCode.port`。端口默认 `8023`，作为只监听 `127.0.0.1` 的 OpenVSCode 上游端口，且不得与管理端口、Zellij Web 端口或任一 code-viewer 端口冲突。OpenVSCode 路径相对配置文件所在目录解析。

`web_sharing` 是 Session 创建时读取的选项，不会追溯修改已经运行的 Session。启用前创建且未主动共享的 Session 需要停止后用相同命令重新创建；管理服务不得为此自动删除现有 Session。

初始化脚本在网络依赖安装之前按下述规则创建证书。未运行初始化脚本时，管理服务首次启动执行相同的创建和校验规则：

1. 证书和私钥都存在时，确认两者为非空普通文件、私钥不允许 group/other 访问、证书未过期且公钥匹配，然后直接复用。
2. 两者都不存在时，通过参数数组调用 `openssl` 创建十年期 RSA-2048/SHA-256 自签名证书；SAN 至少包含 `localhost`、`127.0.0.1` 和 `publicBaseUrl` 的主机。证书权限为 `0644`，私钥权限为 `0600`。
3. 只存在其中一个、文件无效、已过期、密钥不匹配或权限不安全时启动失败，不得覆盖现有文件。

Zellij Web 的独立服务配置必须把 `web_server_cert` 和 `web_server_key` 指向上述文件。

Zellij Web Token 初始化和管理遵循：

1. `zellij.webToken` 同时保存 Token 的 `name` 和 `value`；配置文件权限必须为 `0600`。
2. 配置必须提供固定 Zellij `0.44.3` 的 Token SQLite 文件路径。首次启动时若配置没有 Token，先调用 `web --list-tokens` 初始化并验证数据库，然后使用 Node.js SQLite API创建随机唯一名称和 UUID 值，只把 SHA-256 Token 哈希、名称和只读标志写入 Zellij 的 `tokens` 表；明文名称和值随后原子写入应用配置。数据库权限必须为 `0600`。
3. 不使用 Zellij `0.44.3` 的 `web --create-token`：该版本把 `--create-token` 错误声明为 exclusive，无法配合 `--token-name`；默认名称又使用 `token_<当前记录数+1>`，撤销历史 Token 后可能与已有名称冲突。
4. 配置已有 Token 时，通过 `web --list-tokens` 确认名称仍存在；名称已被撤销时自动创建并保存替代 Token。
5. 重新创建时先创建并保存新名称和值，再使用旧名称调用 `web --revoke-token <old-name>`，避免创建失败导致无可用 Token。
6. 删除时使用配置保存的名称撤销 Token，并从配置删除名称和值。
7. Token 值只能出现在受 VPN/内网保护的专用只读 API 和主页默认隐藏的系统设置面板；普通日志、错误响应和其他 API 不得包含 Token。

只有管理服务 `listenPort` 对外监听，并必须通过主机防火墙限制在 VPN/公司内网网段。Zellij Web、code-viewer 和 OpenVSCode 上游端口只监听 `127.0.0.1`，不得加入防火墙允许列表；Codex Chat 直接运行在管理服务进程内。写请求仍需校验 `Origin`，目录与命令边界不因取消登录或 TLS 而放宽。

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

`zellij.webPort` 必须是 `1-65535` 的整数，且不得与管理、OpenVSCode 或 code-viewer 端口冲突。

Session URL 由服务端生成。打开入口先由同源管理服务使用服务端保存的 Token 登录 localhost Zellij Web，把上游认证 Cookie 写入浏览器响应，再重定向到实际 Session 页面；Token 不得出现在 URL、HTML 或重定向响应中：

浏览器 Cookie 不按端口隔离。为避免同一主机上不同管理端口或不同容器实例的 Zellij `session_token` 互相覆盖，管理代理必须按 `publicBaseUrl` 端口改写浏览器侧 Cookie 名，并把 Path 收敛为 `/zellij`；转发 HTTP 和 WebSocket 请求到各自 localhost Zellij 上游前，再还原为 Zellij 原始 Cookie 名。不得把其他管理端口的认证 Cookie 转发给当前实例。服务端登录固定使用 `remember_me: true`，保留 Zellij 返回的 `Secure`、`HttpOnly`、`SameSite=Strict` 和 `Max-Age` 属性，使手机浏览器后台回收页面后仍可恢复认证。浏览器直接刷新 `/zellij/<session>` 时若 Cookie 缺失，管理代理必须自动重定向到对应 `/zellij/open/<session>`；Cookie 已失效且上游返回未认证入口 HTML 时，代理必须使用服务端 Token 重新登录并返回当前 Session，不得要求用户手工输入 Token。

```typescript
new URL(`${encodeURIComponent(name)}`, `${baseUrl}/open/`).toString()
```

前端不得自行拼接主机或端口。

管理代理注入的终端快捷键盘将 `Ctrl+P X` 视为危险操作。用户点击该快捷键时，浏览器必须先使用原生确认对话框明确提示其会关闭当前 Zellij 面板；只有用户确认后才向终端发送完整按键序列，取消时不得发送任何字符。

## 3. 目录契约

### 3.1 类型和接口

```typescript
type ProjectKind = "directory" | "repository";
type ProjectMarker = "git" | "node" | "python" | "rust" | "go" | "java";
type RepositorySource = "workspace" | "manual";

interface DirectoryEntry {
  id: string;
  name: string;
  relativePath: string;
  kind: ProjectKind;
  source: RepositorySource;
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

interface RepositoryFolderListing {
  current: { id: string; name: string; relativePath: string; gitRepository: boolean };
  parentId: string | null;
  entries: Array<{
    id: string;
    name: string;
    gitRepository: boolean;
  }>;
}
```

接口为：

```http
GET /api/repositories
GET /api/repository-folders?directoryId=<folder_id>
GET /api/repository-folders?initialPath=<relative_path>
POST /api/repositories
DELETE /api/repositories/:repositoryId
```

`GET /api/repositories` 不接受 `parentId`、路径或其他查询参数。服务端把 workspace 扫描结果和手动选择结果合并为单一扁平列表。每个条目的 `source` 表示来自 `workspace` 自动扫描或 `manual` 手动选择；`session` 通过固定 repository Session 名称与当前 Zellij Session 列表匹配，不存在时为 `null`。

“添加文件夹”使用独立的服务器目录选择接口。首次不带查询参数时从服务器文件系统根目录开始；用户也可以提交不以 `/` 开头且不包含 `..` 路径段的相对初始目录，服务端在文件系统根目录下重新执行 `realpath()` containment 校验；后续逐层浏览只允许后端签发的 `folder_<HMAC>` 不透明 ID。响应返回当前目录相对服务器文件系统根目录的规范化 `relativePath`，不返回服务器绝对路径；前端用它同步初始目录输入框。响应还返回当前目录名、父目录 ID、可读子目录名称、子目录 ID，以及目录是否包含 `.git`。`POST /api/repositories` 请求体严格为 `{ "directoryId": "folder_..." }`，重新校验后将目录加入手动列表；`DELETE` 只允许移除手动列表记录，不删除目录或文件；在移除记录前，服务端会清理该目录关联的托管 Zellij Session、Codex 对话状态和 code-viewer 实例。OpenVSCode 是独立的无状态代理，不为目录保存进程状态，因此不会停止全局 OpenVSCode 服务。两个写请求都执行同源 Origin 校验。

### 3.2 工作目录

服务启动时必须接收 `--workspace-root`，并执行 `realpath()`。目录必须存在、可读且为目录，否则启动失败。

保存规范化后的 `workspaceRootRealPath`。不得回退到当前目录、用户主目录或服务器根目录。

服务器文件系统根目录只用于用户主动打开的目录选择器，不替代 workspace root，也不触发递归扫描。选择器每次只读取当前一级目录，并只展示服务进程用户可读取的目录名称；管理入口必须继续受 VPN/公司内网边界保护。

### 3.3 目录 ID

目录 ID 为：

```text
dir_<base64url(HMAC-SHA256(directoryIdSecret, repository-key))>
folder_<base64url(HMAC-SHA256(directoryIdSecret, canonical-folder-path))>
```

`directoryIdSecret` 从持久化 secret 文件读取。文件缺失、不可读或权限过宽时服务拒绝 ready。重启后 secret 必须保持不变。

workspace repository 的 `repository-key` 保持为规范化相对路径，以维持现有 ID 稳定性；手动 repository 使用带域分隔前缀的规范化真实路径。API 不从 ID 反解路径。RepositoryService 只为本次列出的 repository 和目录选择器已经列出的目录登记 ID 索引。未知或失效 ID 返回 `404 DIRECTORY_NOT_FOUND`。

### 3.4 真实路径边界

每次列 repository、选择目录、创建 Session、启动 viewer、生成 OpenVSCode URL 或启动 Codex 对话时都必须重新校验：

1. 从工作目录和已登记相对路径构造候选路径。
2. 对候选路径执行 `realpath()`。
3. 计算 `path.relative(workspaceRootRealPath, targetRealPath)`。
4. 仅当结果不是 `..`、不以 `../` 开头且不是绝对路径时通过。

工作目录自身允许作为根节点。指向根目录外部的符号链接不得出现在结果中。

手动 repository 保存选择时的规范化真实路径。后续操作重新执行 `realpath()`，确认目标仍为目录且仍包含 `.git`；目录选择器则以服务器文件系统根目录作为显式选择边界。浏览器始终只提交不透明 ID，不提交绝对路径。

断链、无权限或扫描期间消失的递归扫描条目跳过并记录 warning。workspace 不存在时返回 `404 DIRECTORY_NOT_FOUND`。

### 3.5 扫描与识别

每次请求先重新校验 workspace 根目录，并按以下顺序处理：

1. 若 workspace 自身包含 `.git` 文件或目录，则只返回 workspace 自身，且不得读取或探测任何子目录。
2. 若 workspace 自身不是 Git repository，则从 workspace 开始递归扫描可见目录，返回任意深度包含 `.git` 文件或目录的 Git repository。
3. 一旦某个目录被识别为 Git repository，将其加入结果并停止深入该 repository；普通容器目录继续递归。
4. 使用真实路径集合避免符号链接循环；指向 workspace 外部的符号链接跳过。
5. 结果以扁平列表返回，不提供面包屑导航操作。
6. 将仍然存在且仍包含 `.git` 的手动 repository 合并到结果中，按真实路径去重；手动条目的 `relativePath` 用规范化绝对路径显示，`source` 为 `manual`。

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

目录选择器单次只列当前一级，最多接受 1000 个目录项，读取超时 5 秒。无权限目录不进入列表；当前目录不可读返回 `403 DIRECTORY_NOT_READABLE`。当前目录或可读子目录均可作为手动目录添加，不要求包含 `.git`；手动选择路径写入权限为 `0600` 的状态文件，服务重启后恢复。列表中的非 Git 手动目录标记为 `directory`，Git 手动目录标记为 `repository`。

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

### 4.5 Zellij Web 代理

Zellij Web 必须只监听 `127.0.0.1:<zellij-port>`。浏览器入口固定为 `<publicBaseUrl>/zellij/<session-name>`，不得返回或跳转到 Zellij Web 上游端口。

管理服务必须移除 `/zellij` 前缀并代理 Zellij Web 的普通 HTTP、登录请求和 WebSocket Upgrade。Zellij `0.44.3` 入口 HTML 固定包含 `<base href="/" />`，管理服务只对合法入口路径 `/zellij/` 和 `/zellij/<session-name>` 的 HTML 响应把它改为 `<base href="/zellij/" />`；静态资源、API 和 WebSocket 响应保持流式转发，不修改正文。入口 HTML 最大允许 1 MiB，超过限制时代理失败。

Zellij Session 入口页面的浏览器标题固定为 `<repository-name> - Zellij`。repository 名称优先通过 managed session metadata 的 repository ID 在服务端解析，其次按固定 repository Session 命名规则匹配；无法映射的 external Session 使用 Session 名称作为标题前缀。入口 HTML 必须锁定标题，防止 Zellij 初始化后用 Session 名称覆盖。前端不得提交或拼接标题。

合法入口 HTML 还必须在桌面和移动浏览器中注入浮动终端快捷键盘。页面首次打开时默认位于右侧垂直中间并贴边收起，隐藏球体主体并只保留一段半透明可点击圆弧，不改变终端容器尺寸；点击或拖动圆弧时立即恢复完整按钮，之后再次收起并闲置 3 秒后自动缩进最近的屏幕边缘。每次进入贴边收起状态前都必须先把浮球从当前位置吸附到最近的左右侧边，不能假设浮球已经处于边缘。浮球已经贴边隐藏时，点击页面其他区域不得将其唤醒。拖动结束后浮球吸附到最近的左右侧边，只保存贴边方向和垂直位置比例；浏览器尺寸、横竖屏或桌面版模式变化时必须使用变化前保存的垂直比例按新视口重新计算位置并保持贴边，不得从变化后的视口和旧像素位置反推比例，也不得使用旧视口的绝对水平像素。移动浏览器切换桌面版模式或页面缩放比例变化时，只允许浮球尺寸、快捷键展开半径、每个快捷按钮内的文字、主浮球文字、按钮提示文字和提示间距使用同一缩放系数反向补偿页面缩放并设置合理上限；Zellij xterm 字号和终端内容不得补偿，必须维持浏览器原生缩放。软键盘显示时终端使用 `visualViewport` 可用高度；键盘关闭、输入失焦、页面重新可见或从后台恢复后，终端必须恢复为 `100dvh`，并允许视口恢复逻辑触发有限次数的延迟全局 `resize` 使 Zellij 重新 fit。快捷球自身的拖动、展开或缩放不得派发额外的全局 `resize` 事件。展开布局使用两个同心圆：主浮球圆心位于内圆上，所有快捷按钮圆心位于外圆上，外圆半径比内圆半径大约 `1.5` 个小球直径；六个快捷按钮沿外圆面向屏幕内侧的弧线均匀分布且不得重叠。浮球拖到顶部或底部附近时必须限制其垂直位置，使完整外圆按钮弧仍位于浏览器安全区内。再次点击浮动按钮或点击浮动控件以外的页面区域时必须自动收起。前端不得提交自定义按键、命令或参数。所有圆形操作按钮都通过 Zellij Web 已建立的终端发送函数在单次调用中完整写入对应控制序列，不得拆分成多条 WebSocket 消息；其中上方向键写入 `ESC [ A`，下方向键写入 `ESC [ B`，避免浏览器合成键盘事件被 xterm 忽略。桌面浏览器点击任一圆形操作按钮时保持 Zellij xterm 当前编辑焦点；触摸设备点击任一快捷按钮时主动清除可编辑元素焦点以收起软键盘，但仍发送对应终端序列。快捷按钮不得主动聚焦 Zellij xterm 或其他可编辑输入。`Ctrl+P N`、`Ctrl+P X` 和 `Ctrl+C` 发送后自动收起，`Tab`、上方向键和下方向键为便于连续使用而保持展开。浮动控件必须位于浏览器安全区内，并且收起时不得占用整行或缩短终端高度；拖动浮动按钮时必须阻止浏览器平移手势，并按动画帧合并位置更新。

固定 Zellij `0.44.3` 自带的已知 `/zellij/assets/*` 静态资源必须返回 `Cache-Control: private, max-age=86400, immutable` 和包含版本、文件名的弱 `ETag`。浏览器发送匹配的 `If-None-Match` 时，管理服务必须直接返回 `304`，不得访问 Zellij 上游。客户端声明接受 gzip 时，大于等于 1 KiB 的可压缩响应使用 gzip 传输并设置正确的 `Content-Encoding` 与 `Vary`；请求正文解压必须保持关闭。入口 HTML、登录/API 响应和 WebSocket 不得使用静态资源长期缓存策略。

Zellij Web 保留自身 Token 与 Cookie 认证。通过同源 `/zellij` 入口登录后，浏览器只与主服务 HTTPS 端口通信；Zellij 上游端口不得加入防火墙允许列表。

### 4.6 OpenVSCode 编辑入口

每个 repository 条目的“code-viewer”旁边显示“编辑代码”链接。链接在新标签页打开，并设置 `rel="noopener noreferrer"`。

CodeReviewer 入口页面的浏览器标题固定为 `<repository-name> - CodeReviewer`，其中 repository 名称由 viewer 实例绑定的 repository ID 在服务端重新解析，前端不得提交或拼接标题。只允许改写入口 HTML；静态资源、SSE 和其他代理响应保持流式转发。

OpenVSCode Server 是部署侧独立启动的编辑服务，但不得直接暴露其 HTTP 端口。后端必须对每个 repository ID 重新执行真实路径解析、Git repository 检查和对应来源的路径边界校验，然后基于 `publicBaseUrl` 和校验后的 repository 绝对路径生成同源 HTTPS URL：`<publicBaseUrl>/openvscode/?folder=<encoded-absolute-path>`。`GET /api/repositories` 在每个 repository 条目中返回对应的 `openVSCodeUrl`；OpenVSCode 将 `folder` 参数解析为远程目录并自动打开该 repository。

前端必须直接使用条目中的 `openVSCodeUrl`，不得自行拼接或提交服务器绝对路径、命令、环境变量或任意端口。后端只可为 workspace 扫描结果或已持久化的手动 Git repository 生成 URL；已经消失或不再是 Git repository 的目录不得生成 URL。

管理服务必须把 `/openvscode` 下的普通 HTTP 请求和 WebSocket Upgrade 流式代理到 `http://127.0.0.1:<openVSCode.port>`，保留 `/openvscode` 基路径，并使用 `publicBaseUrl` 的 authority 和 HTTPS Origin 生成上游请求头。这样非 localhost 浏览器仍处于安全上下文，Codex 等依赖 Webview、Worker 或安全浏览器 API 的扩展能够正常渲染。OpenVSCode 上游不得加入防火墙公开端口。

OpenVSCode 入口页面的浏览器标题固定为 `<repository-name> - openvscode`。repository 名称由后端已校验后生成的 `folder` 参数取 basename，入口 HTML 必须锁定该标题以防 OpenVSCode 初始化后覆盖；静态资源、API 和 WebSocket 不修改正文。

OpenVSCode 进程的工作目录必须设置为配置给管理服务的同一 workspace root。部署命令的参数数组固定为：

```text
["--host", "127.0.0.1", "--port", String(openVSCode.port), "--server-base-path", "/openvscode", "--without-connection-token", "--accept-server-license-terms", "--telemetry-level", "off"]
```

该入口与 code-viewer 代理相互独立，也不改变 code-viewer 只监听 localhost 的约束。OpenVSCode localhost 上游端口只能由配置和部署侧决定，不能由前端请求修改。

OpenVSCode 平时仍是独立进程，但统一重启脚本负责停止并重新拉起本项目配置的实例。停止时必须校验可执行文件安装目录和固定端口，并终止其独立进程组，以清理 Server、Extension Host 等子进程；不得按进程名全局终止其他 OpenVSCode 实例。

### 4.7 Codex 浏览器对话

repository 条目的“与 Codex 对话”链接必须在新标签页打开 `/codex-chat?repositoryId=<encoded-id>`，并设置 `rel="noopener noreferrer"`。对话页面必须先通过 `GET /api/repositories` 确认 ID 仍对应当前列表中的 Git repository；前端不得把 relative path 转换为服务器路径，也不得提交绝对路径、命令、命令参数、环境变量、KDL、可执行文件或 Codex 配置。

Codex 对话页面在 repository 校验成功后把浏览器标题设置为 `<repository-name> - Codex`；repository 不可用或尚未加载时使用通用 `Codex` 标题。标题只能使用 `GET /api/repositories` 返回的名称。

对话页面在运行中的助手消息尚无文本时显示等待动画；一旦收到部分助手文本且快照状态仍为 `running`，最新助手消息必须继续显示动态生成提示，直到快照进入非运行状态后移除。历史助手消息和已经完成的最新消息不得显示该提示。脱敏活动卡片按所属助手消息显示在回复正文之前。用户位于消息列表底部附近时，新增流式内容自动跟随到底部；用户主动向上滚动后停止自动跟随，不得因后续增量快照强制改变阅读位置，并显示可手动回到最新消息的入口。消息输入区必须位于同一滚动区域末尾并随消息滚动，不得固定或 sticky 在视口底部。

对话页面加载时还必须调用 `GET /api/codex/status`。后端使用 `execFile()`、参数数组 `['--version']`、`shell: false`、5 秒超时和 64 KiB 输出上限检查服务进程实际使用的 Codex 可执行文件。命令成功且 stdout 去除空白后匹配受限的 `codex-cli <version>` 格式时返回 `{ available: true, version: string, mode: 'yolo' | 'sandbox' }`；可执行文件不存在、不可执行、超时、退出非零或版本输出不匹配时返回 `{ available: false, version: null, mode: 'yolo' | 'sandbox' }`。当前 app-server 固定 `approvalPolicy: "never"`，因此 `mode` 返回兼容标签 `yolo`；该标签不改变下文的 `workspaceWrite` 沙箱约束。原始错误和未匹配的命令输出不得返回浏览器或写入普通错误响应。

Codex 页面默认字体通过配置中的 `codexChatAppearance` 设置。`fontFamily` 是长度不超过 200 的非空 CSS 字体族字符串，`fontSize` 是 `12` 到 `24` 的整数像素值；未配置时分别使用 `Inter, ui-sans-serif, system-ui, sans-serif` 和 `16`。页面通过 `GET /api/codex/appearance` 只读取 `{ fontFamily, fontSize }`，不得返回完整应用配置、路径、Token 或其他服务端字段。配置在管理服务启动时读取，修改后需要重启服务生效。任意 Codex 页面必须允许用户在抽屉中即时覆盖字体族和字号，并把覆盖值保存到当前浏览器的 `localStorage`，供所有 repository 的 Codex 页面共享；恢复默认操作删除该覆盖值并重新使用服务端配置。

页面只有在 `available` 为 `true` 时才允许发送消息。不可用时必须显示可理解的提示，要求检查 Codex CLI 安装、可执行权限和后台服务用户的 `PATH`。`POST /api/codex/messages` 在解析 repository 后、启动后台 turn 前必须再次执行同一检查；不可用时返回 `503 CODEX_CLI_UNAVAILABLE`，不得启动 Codex turn。

`POST /api/codex/messages` 请求体严格为：

```typescript
interface CodexChatRequest {
  repositoryId: string;
  conversationId?: string;
  contextFileIds?: string[];
  message: string;
}
```

`repositoryId` 使用目录 ID 格式；`conversationId` 必须是 UUID；`contextFileIds` 最多包含 8 个互不重复的 `file_` opaque ID；`message` 去除首尾空白后长度为 1 到 20000 个字符。请求拒绝额外字段，并执行与其他写请求相同的严格同源 Origin 校验。后端必须通过 RepositoryService 重新执行真实路径解析、Git repository 检查和对应来源的路径边界校验。

“Add file”只能使用 `GET /api/repositories/:repositoryId/files` 返回的文件。该接口重新校验 repository 后递归扫描普通文件，跳过符号链接、`.git`、依赖目录和构建输出；单文件超过 128 KiB 时不进入列表。响应只返回服务端 HMAC 签发的 `file_` ID、repository 相对路径和字节数，不返回文件内容或服务器绝对路径。最多扫描 2000 个目录、返回 5000 个文件；达到限制时返回 `truncated: true`，前端提示通过相对路径搜索缩小范围。

消息执行前，后端根据进程内文件索引确认每个 ID 属于同一 repository，并对每个文件重新执行 `realpath()`、repository containment 和普通文件检查。单次最多 8 个文件、单文件最多 128 KiB、总计最多 512 KiB，只接受无 NUL 且可严格解码为 UTF-8 的文本；越界符号链接、失效或伪造 ID、二进制文件和超限内容必须在建立 Codex 响应流前拒绝。前端不得提交相对路径或绝对路径代替文件 ID。

经校验的文件以包含 repository 相对路径和内容的 JSON 加入服务端 prompt。prompt 明确把文件内容视为不可信源数据而非指令，并要求 Codex 优先只使用用户为本次 turn 选择的文件；仅在用户明确要求或任务无法完成时才检查其他文件。该限定不改变 Codex CLI 的 repository 工作目录和 `workspace-write` 沙箱边界。

首次对话使用服务端固定的 Codex app-server JSON-RPC 调用。管理服务以参数数组
`["app-server", "--listen", "stdio://"]`、`cwd` 为重新校验后的 repository 真实路径、
`shell: false` 启动独立进程，并先完成 `initialize`/`initialized` 握手，再调用
`thread/start`。继续对话调用 `thread/resume`。页面需要历史但服务端进程内没有快照时，必须调用 `thread/read` 并设置 `includeTurns: true`，从已保存的 thread turns 恢复脱敏的用户与助手消息及受支持的活动摘要；不得把原始历史事件、工具输出、附件内容、标准错误或服务器绝对路径返回浏览器。每个 turn 使用 `turn/start`，输入为服务端
生成的 prompt 文本，固定 `approvalPolicy: "never"`、`sandboxPolicy.type: "workspaceWrite"`，
`summary: "detailed"`，可写根目录只包含当前 repository。前端不得提交任意 app-server 方法或字段。

app-server 进程使用独立进程组，浏览器不能控制可执行文件、参数、cwd、沙箱或审批策略。服务端进程内和状态文件中已知的 conversation ID 必须保持 repository 归属校验。

同一 thread 正在其他 Codex 客户端中持有 active writer 时，`thread/resume` 失败必须分类为 `409 CODEX_CONVERSATION_IN_USE`，对话快照只显示“该对话正在另一个 Codex 客户端中使用，请关闭该客户端或新建对话。”，不返回 thread ID 或原始错误。本次未进入 `turn/start` 的用户消息、助手占位和活动必须从服务端快照回滚，`turn.completed` 同时携带安全的回滚消息 ID，浏览器必须立即删除对应的本地占位，避免重试后留下重复消息。服务端不得自动终止其他客户端或自动 fork 对话。其他 app-server 错误继续返回通用脱敏错误。

服务端按 repository ID 保存进程内对话快照，包括 conversation ID、用户与助手消息、脱敏活动摘要、运行状态、脱敏错误和更新时间。浏览器关闭、刷新或网络断开不得取消后台 turn；只有显式停止、30 分钟超时、输出超限或管理服务关闭才终止进程组。同一 repository 同时只能有一个运行中的 turn。只有 Codex turn 成功完成并返回合法 thread ID 后，服务端才把 repository ID 到 conversation ID 的映射原子写入状态文件；运行中、失败、停止或超时的 turn 不得覆盖已持久化 ID。管理服务重启后从状态文件恢复该映射，页面无需依赖浏览器缓存即可获得可继续的 conversation ID。

`GET /api/codex/conversations/:repositoryId` 返回当前服务进程内的快照或 `null`；如果只有状态文件中的 conversation ID，则服务端先通过 `thread/read` 恢复完整的脱敏历史后再返回。运行中的快照 `phase` 为 `starting` 或 `generating`：前者表示 Codex app-server 尚未完成 initialize/thread 握手，后者表示已建立 thread 并开始 turn；失败、停止或完成的快照不返回该字段。`GET /api/codex/activity` 返回当前仍在运行的 repository ID 列表，供管理首页在 Codex 对话页关闭后显示“生成中”状态；该状态只来自服务端活动 turn，不依赖浏览器缓存。

页面进入时先读取该快照，并建立同源 `GET /api/codex/conversations/:repositoryId/events` SSE 连接。SSE 使用命名事件而不是反复发送完整快照：连接建立或自动重连时先发送一次 `conversation.snapshot`，运行中发送 `turn.started`、`thread.started`、`turn.steered`、`app-server.event`、`activity.updated`、`message.delta`、`message.completed` 和 `turn.completed`，清空对话时发送 `conversation.cleared`。每条 SSE 的 `event` 字段和 JSON `data.type` 必须相同。每一条从 app-server stdout 成功解析的 JSON-RPC response、notification 或 server request 都必须按接收顺序产生一个递增 sequence 的 `app-server.event`；该事件只包含消息类型、method、request/thread/turn/item ID、接收或完成状态和时间，不得包含原始 `params`、`result`、`error` 或完整 payload。`message.delta` 只包含助手消息 ID 和新增文本；密集的 app-server `item/agentMessage/delta` 可以在不超过 40 毫秒的窗口内合并为一个 `message.delta`。`message.completed` 携带该助手消息的最终脱敏文本，`turn.completed` 携带最终状态、脱敏错误和最终助手消息或明确的空值，供浏览器校正丢失的增量。

`activity.updated` 只转换以下 app-server 事件：`reasoning`/`plan` 的对外 detailed summary、`commandExecution` 的实际命令文本与开始/完成状态、`fileChange` 的 repository 内相对路径与变更类型、`mcpToolCall`/`dynamicToolCall`/`collabToolCall` 的服务和工具名称，以及 `webSearch`、`imageView`、`contextCompaction` 的通用动作名称。命令文本和 summary 中的当前 repository 绝对路径替换为 `.`，单项 detail 最多保留 8000 个字符。原始 private reasoning content、命令输出、工具 arguments/result/error、diff 正文、usage、stderr、repository 外文件内容和原始失败详情不得进入活动摘要或浏览器响应。

浏览器按顺序把这些类型化事件归并为本地快照。连接断开不得取消后台 turn，浏览器自动重连后通过新的 `conversation.snapshot` 恢复完整当前状态；服务端必须在响应关闭、响应错误或客户端请求中止时释放该 SSE 订阅和心跳定时器。浏览器以不超过每 100 毫秒一次的频率把运行中快照保存到 `localStorage`，最终状态必须立即保存；快照不含服务器路径和文件内容。浏览器快照只用于兼容回退和未完成流的短暂恢复，不得阻止新浏览器或新设备通过服务端 thread 历史恢复。旧的 `running` 状态必须转换为已中断，不得假装后台仍在运行。用户发送下一条消息时通过 app-server 的 `thread/resume` 继续该 conversation。

`POST /api/codex/messages` 成功启动后台 turn 时返回 `202` 和启动后的对话快照。运行中的输入只能提交到 `POST /api/codex/conversations/:repositoryId/steer`，请求体严格为 `{ "message": string }`；后端在 repository 和 Origin 校验后把它固定转换为 `turn/steer`，参数只能包含服务端保存的 `threadId`、当前 `expectedTurnId` 和 text input。成功时追加新的用户消息和助手消息锚点，发送 `turn.steered` 并返回 `202` 快照。握手未完成、turn 已结束或没有活动控制器时返回 `409`。浏览器不得提交 JSON-RPC method、request ID、thread/turn ID 或任意 app-server params。`POST /api/codex/conversations/:repositoryId/stop` 显式停止当前 turn；`DELETE /api/codex/conversations/:repositoryId` 仅在没有运行中 turn 时清空快照，供“新对话”使用。Codex app-server 原始 JSONL/JSON-RPC payload 不直接返回浏览器，只发送上文定义的安全元数据与类型化内容事件。

服务端从 app-server 的 `item/agentMessage/delta` 和已完成 `agentMessage` 项提取助手文本，并按上文规则把受支持的 item 生命周期转换为脱敏活动摘要；其他原始事件只产生安全的 `app-server.event` 元数据，不转换原始 payload。助手文本、命令文本和 reasoning summary 中出现的当前 repository 绝对路径替换为 `.`。流开始后的失败写入脱敏的失败快照；流开始前的 schema、Origin、repository 和就绪错误继续使用标准 JSON 错误响应。

每次 Codex turn 最长运行 30 分钟，stdout 上限为 4 MiB，保留的 stderr 诊断上限为 64 KiB且不得返回前端。显式停止、输出超限、超时或管理服务关闭时，必须先向 Codex 独立进程组发送 `SIGTERM`；5 秒后仍未退出则发送 `SIGKILL`。浏览器取消请求或 HTTP 响应关闭不得终止后台 turn。管理服务关闭时取消所有活动 Codex turn，但仍不得删除 Zellij Session。

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
| `GET` | `/api/repository-folders` | `200` | 通过不透明目录 ID 逐层浏览服务器目录 |
| `POST` | `/api/repositories` | `201` | 添加手动 Git repository |
| `DELETE` | `/api/repositories/:repositoryId` | `204` | 从列表移除手动 repository |
| `GET` | `/api/zellij-token` | `200` | 读取主页 Token 管理侧边栏展示的名称和值 |
| `POST` | `/api/zellij-token/regenerate` | `201` | 创建或重新创建 Zellij Web Token |
| `DELETE` | `/api/zellij-token` | `204` | 撤销并删除当前 Zellij Web Token |
| `GET` | `/api/viewers` | `200` | 当前进程的 viewer 列表 |
| `POST` | `/api/viewers` | `200` 或 `201` | 复用或创建 viewer |
| `DELETE` | `/api/viewers/:id` | `204` | 停止 viewer |
| `GET` | `/api/codex/status` | `200` | 检查后台服务能否调用 Codex CLI 并返回版本 |
| `GET` | `/api/codex/appearance` | `200` | 返回 Codex 页面配置的字体族和字号 |
| `GET` | `/api/codex/activity` | `200` | 返回仍在运行 Codex turn 的 repository ID |
| `GET` | `/api/codex/conversations/:repositoryId` | `200` | 获取 repository 当前 Codex 对话快照 |
| `GET` | `/api/codex/conversations/:repositoryId/events` | `200` | 通过同源 SSE 实时推送 Codex 对话快照 |
| `GET` | `/api/repositories/:repositoryId/files` | `200` | 返回可作为 Codex 上下文的 repository 文件 opaque ID |
| `POST` | `/api/codex/messages` | `202` | 在后台创建或继续 Codex 对话 |
| `POST` | `/api/codex/conversations/:repositoryId/steer` | `202` | 向当前运行中的 Codex turn 追加自然语言输入 |
| `POST` | `/api/codex/conversations/:repositoryId/stop` | `202` | 停止 repository 当前运行的 Codex turn |
| `DELETE` | `/api/codex/conversations/:repositoryId` | `204` | 清空 repository 当前 Codex 对话快照 |
| `POST` | `/api/services/restart` | `202` | 清理全部托管后台进程，并只重启管理服务与 Zellij Web |

`DELETE` 请求不接受请求体。`POST /api/services/restart` 只接受空 JSON 对象并拒绝额外字段。`GET /api/viewers` 按 `createdAt` 升序返回。

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

页面、API、Codex 后台对话、Zellij Web、viewer 和 OpenVSCode 代理必须全部通过 `publicBaseUrl` 同源 HTTPS 访问。Zellij Web 使用 `/zellij/<session>`，code-viewer 使用 `/viewer/<viewer_id>/`，OpenVSCode 使用 `/openvscode/`。所有写请求的 `Origin` 必须等于 `publicBaseUrl`。

服务重启接口同样执行严格同源校验。前端不能提交 workspace、配置文件、端口、PID、命令、环境变量或服务列表。

访问控制由 VPN/公司内网和主机防火墙承担。只有公开管理端口允许受控网段访问；Zellij Web、code-viewer 与 OpenVSCode 上游端口只监听 localhost。

Zellij Web 保留自身 Token 验证。管理服务按第 1.3 节保存和管理专用 Zellij Web Token，并只通过主页专用接口展示。Token 管理写请求必须执行同源 Origin 校验。

取消应用登录不改变目录 containment、命令允许列表、请求 schema、实例限制、审计日志或错误脱敏要求。

## 7. 状态契约

### 7.1 文件

状态文件固定为 `data/state.json`：

```json
{
  "version": 3,
  "sessions": [],
  "viewers": [],
  "repositories": [],
  "codexConversations": []
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

状态文件保存 managed Session 元数据、viewer 清理元数据、用户手动选择的规范化 repository 真实路径，以及成功完成的 repository ID 到 Codex conversation ID 映射；不保存 Codex 消息、附件内容、Token、命令输出或其他秘密。版本 1 和版本 2 文件在读取后迁移为版本 3，已有 Session 和 repository 元数据必须保留。

### 7.3 恢复与退出

启动时通过 Zellij CLI 恢复真实 Session 集合，并合并 managed 元数据。状态文件中存在但真实 Zellij 集合中已不存在的 Session 记录必须删除并原子写回；若启动时无法查询 Zellij，则保留原记录，不得猜测删除。

首版不接管历史 viewer。历史 PID 只在同时验证命令和启动时间属于本服务时终止，随后清空 viewer 和端口记录。用户下次访问时重新创建。

Node.js CLI 必须以 `0600` 原子保存启动时已校验的配置文件、workspace root、浏览器 host 和管理端口。`codepilot-server stop` 必须先验证 PID 文件指向本应用的管理服务，再发送 `SIGTERM`；管理服务的 Fastify close hook 必须停止所有 code-viewer 和活动 Codex CLI 进程组。每个独立启动的 code-viewer 与 Codex app-server 还必须把 PID、进程组、启动时间和完整参数原子登记到权限为 `0600` 的托管进程文件，并在退出时移除；登记失败时立即终止对应进程组。最多等待 10 秒优雅退出，超时后明确升级为 `SIGKILL`。管理进程退出后，CLI 必须使用已保存的运行元数据调用统一 runtime cleanup，按登记身份、进程身份和固定端口停止 Zellij Web、残留 Codex、code-viewer、OpenVSCode 和其他本项目托管后台进程。即使 PID 文件缺失或失效，只要运行元数据存在也必须执行 cleanup。任何停止路径都不得删除 Zellij Session。

`codepilot-server start` 在启动管理进程前必须执行幂等的 support-service ensure：Zellij Web 或 OpenVSCode 端口空闲时启动对应服务；已由配置匹配的本项目进程监听时复用并重建 `0600` PID 文件；被无关进程占用时拒绝启动。该检查不要求管理端口或按需 code-viewer 端口空闲。统一 restart 使用其只确保 Zellij Web 的受限变体，不得自动恢复 OpenVSCode。

收到 `SIGTERM` 时：

1. 停止接受新请求。
2. 最多等待 10 秒完成进行中的请求和状态写入。
3. 停止所有当前管理的 viewer 进程组。
4. 不删除 Zellij Session。

统一重启复用上述退出流程；管理进程退出后还必须清理已确认属于本项目的遗留 viewer 进程组和端口记录，然后才能重新启动支持服务。

理由见 [ADR-003](decisions/003-state-recovery.md)。

## 8. 前端契约

- 每个 repository 只对应一个由服务端命名的 Session，前端不要求用户输入 Session 名称。
- Workspace 管理区提供“会话列表”按钮；Session 表格默认隐藏在弹窗中，弹窗支持关闭按钮、遮罩和 Esc 关闭，并在打开会话或成功删除会话后自动关闭。
- repository 没有对应 Session 时显示创建操作；创建成功后刷新 Session 和 repository 列表，不自动打开新标签页。
- repository 已有对应 Session 时显示后端返回的 Zellij Web 打开链接和删除操作。
- 点击浏览时同步打开同源 `/viewer-launch/<repository_id>` 启动页，不依赖原页面持有新标签页的窗口句柄。
- 启动页只使用路径中的合法 repository ID 调用固定的 `POST /api/viewers`；成功后用后端返回的 `webUrl` 替换自身地址，失败时在启动页显示可理解的错误。
- `window.open()` 返回 `null` 时原页面提示允许弹窗；即使移动浏览器实际打开标签页但不返回窗口句柄，启动页仍必须独立完成启动和导航，不能停留在空白页。
- 打开链接使用后端 URL，设置 `target="_blank"` 和 `rel="noopener noreferrer"`。
- 删除 Session 要求用户输入准确名称确认。
- 只读列表每 10 秒刷新；页面不可见时暂停，恢复可见时立即刷新。
- 轮询不得覆盖本地 `starting`、`stopping` 或删除中状态。
- 相对路径只作为文本渲染，不使用 `dangerouslySetInnerHTML`。
- viewer URL 不持久化到 localStorage。
- 主页默认不显示 Zellij Web Token 名称和值；通过系统设置按钮打开默认隐藏的系统设置面板后显示名称和值，并提供复制、删除和重新创建操作。系统设置面板同时提供后台服务重启操作，并支持关闭按钮、遮罩和 Esc 关闭。
- 删除和重新创建 Token 必须二次确认；Token 操作完成后立即更新页面状态。
- 页面提供“重启后台服务”操作并二次确认，明确提示现有 Web/编辑连接会断开但 Zellij Session 会保留。请求被接受后按钮保持禁用，前端等待管理服务实际离线并恢复健康后刷新页面。
- 管理服务、系统就绪状态、Zellij、code-viewer、OpenVSCode 和 Codex CLI 状态不常驻首页，集中放在默认关闭的“系统状态”页面中；页面同时显示管理服务、Zellij、code-viewer、OpenVSCode 和 Codex CLI 的版本信息，其中 Codex CLI 使用现有 `/api/codex/status` 的脱敏版本信息；页面支持关闭按钮、遮罩和 Esc 关闭。
