# Terminal Web

当前实现覆盖 MVP-0 外部工具验证和 MVP-1 管理功能。管理入口监听 `0.0.0.0`，通过服务器 IP 提供 HTTPS；workspace 自身为 Git repository 时显示自身，否则递归发现各级子目录中的 Git repository，并以扁平列表展示。主页“添加文件夹”还能逐层选择服务器上的其他 Git repository。code-viewer 上游仍限制在 localhost。

## 环境

- Node.js `26.x`（当前基线 `26.5.1`）
- Zellij `0.44.3`
- code-viewer `0.10.0`
- OpenVSCode Server `1.109.5`

## 配置

复制 `config.example.json` 为 `config.json`，把 `publicBaseUrl` 改为唯一对外 HTTPS 访问地址，例如 `https://192.168.1.20:8020`。Zellij Web 的 localhost 上游端口通过 `zellij.webPort` 配置。

准备权限受限的目录 ID secret。管理页面不需要用户名、密码或 TLS 证书：

```bash
mkdir -p data
openssl rand -base64 32 > data/directory-id.secret
chmod 600 data/directory-id.secret
```

必须通过防火墙只允许 VPN/公司内网访问管理端口。

## 构建与启动

### 首次准备

推荐使用交互式初始化脚本。它会生成 Zellij Web 自签名证书，安装 nvm 和 Node.js 26、安装项目依赖及固定版本 Zellij 和 OpenVSCode Server、创建 `config.json`、配置 Zellij Web，并生成目录 ID secret。证书生成在网络安装步骤之前完成，因此后续下载失败时可以直接重试初始化。脚本只负责初始化配置，不会启动管理服务或 OpenVSCode：

```bash
scripts/download-zellij.sh
scripts/download-openvscode.sh
scripts/init.sh
```

建议在运行 `init.sh` 前先执行 `scripts/download-zellij.sh`。该脚本会显示 GitHub Release 下载进度，将固定版本 `0.44.3` 下载并验证到 `data/zellij/zellij`，然后复制到 `$HOME/.local/bin/zellij`。如果跳过此步骤，`init.sh` 会提示确认，继续后由 `npm install` 自动下载。

OpenVSCode 使用独立的 `scripts/download-openvscode.sh` 下载。该脚本显示官方 GitHub Release 下载进度，验证发布页提供的 SHA-256 摘要和 `1.109.5` 版本后安装到 `data/openvscode/`；`init.sh` 会自动调用并复用已验证的安装。

也可以传入参数进行无人值守初始化：

```bash
scripts/init.sh --host 192.168.1.20 --service-port 8020 --zellij-port 8021 --viewer-port 8022 --openvscode-port 8023 --non-interactive
```

使用 `scripts/init.sh --help` 查看全部参数。脚本不会配置主机防火墙；只需允许 VPN 或公司内网访问管理端口。Zellij Web、OpenVSCode 与 code-viewer 上游端口只监听 localhost，不应加入防火墙允许列表。

初始化完成后，显式启动后台服务：

```bash
npm run service:start -- /实际/workspace/路径
```

OpenVSCode Server 是独立进程，使用相同 workspace root 和配置端口启动；默认命令为：

```bash
(cd /实际/workspace/路径 && /项目路径/data/openvscode/current/bin/openvscode-server \
  --host 127.0.0.1 \
  --port 8023 \
  --server-base-path /openvscode \
  --without-connection-token \
  --accept-server-license-terms \
  --telemetry-level off)
```

初始化脚本会创建 HTTPS 证书；管理服务首次启动时会校验证书并初始化 Zellij Web Token。没有使用初始化脚本时，管理服务仍会在证书和私钥都不存在时创建证书。

如果尚未安装 nvm，先安装并加载 nvm：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm --version
```

安装脚本会尝试把 nvm 加载配置写入当前用户的 shell 配置文件。新开终端后通常无需再次手动执行 `export` 和加载命令。

进入项目目录，安装并使用 Node.js 26，然后安装依赖：

```bash
cd /data01/home/lihui/projects/code_pilot_web
nvm install 26
nvm use 26
npm install
```

复制配置文件，并根据服务器的实际 IP 或域名修改 `config.json`：

```bash
cp config.example.json config.json
```

- `publicBaseUrl` 必须使用 HTTPS，例如 `https://192.168.1.20:8020`。
- `zellij.webPort` 默认是 localhost 上游端口 `8021`；浏览器通过 `publicBaseUrl/zellij/` 访问，不直接访问该端口。
- `zellij.configFile` 和 `zellij.webTokenDatabaseFile` 必须指向运行服务用户的 Zellij 配置及数据目录。
- `openVSCode.executableFile` 指向独立下载脚本安装的程序，`openVSCode.port` 默认是 localhost 上游端口 `8023`，且不能与管理、Zellij Web 或 code-viewer 端口冲突。浏览器通过管理入口的同源 HTTPS `/openvscode/` 访问，不直接访问该端口。

生成权限受限的目录 ID secret：

```bash
mkdir -p data
openssl rand -base64 32 > data/directory-id.secret
chmod 600 data/directory-id.secret
```

### 开发模式

开发模式会同时监听前端和后端源码：前端由 Vite 重新构建到 `dist/web`，后端自动重启并提供最新静态文件。

```bash
npm run dev -- --workspace-root /实际/workspace/路径
```

`--workspace-root` 是必填参数；未传入时服务会报错退出。该目录必须存在、可读，并且自身是 Git repository 或包含需要管理的 Git repository。

如需打开 workspace 之外的仓库，在主页 Git 仓库区域点击“添加文件夹”，从服务器根目录逐层进入目标目录，然后点击“选择 Git 仓库”。浏览器只提交服务端签发的不透明目录 ID，不提交绝对路径；只有包含 `.git` 的目录可选择。手动仓库会写入 `data/state.json` 并在服务重启后保留。“移除仓库”只从列表移除记录，不删除服务器文件或 Zellij Session。

### 正式模式

先构建前端和服务端，再启动编译产物：

```bash
npm run build
npm start -- --workspace-root /实际/workspace/路径
```

也可以直接运行编译入口：

```bash
node dist/server.js --config config.json --workspace-root /实际/workspace/路径
```

服务启动后，在浏览器访问 `config.json` 中配置的 `publicBaseUrl`。默认监听端口为 `8020`，例如 `https://192.168.1.20:8020`。管理页面无需登录，但必须通过防火墙限制为仅允许 VPN 或公司内网访问。

### 浏览器中与 Codex 对话

管理服务会调用其运行用户 `PATH` 中的 `codex` CLI。启动服务前，需要确保同一用户可以在目标 repository 中直接运行 Codex，且认证和 Codex 配置已经准备完成。浏览器不会接收或提交 API Key、命令、路径或环境变量。

在主页的 Git repository 条目中点击“与 Codex 对话”，会在新标签页打开独立对话页面。页面首先通过后台执行 `codex --version` 检测 CLI；检测成功后显示版本并启用输入，检测失败则禁用发送，并提示检查安装、可执行权限和后台服务用户的 `PATH`。输入框中的“Add file”可以搜索并选择当前 repository 内最多 8 个普通 UTF-8 文本文件，作为下一条消息的重点上下文；前端只提交服务端签发的文件 ID，不提交服务器路径。首条消息创建 conversation，后续消息在同一 repository 中继续；“新对话”会开始新的 conversation，“停止”会取消当前 turn。conversation 绑定只保存在管理服务内存中，因此服务重启后需要开始新对话。

Codex 以该 repository 为工作目录，并使用固定的 `workspace-write` 沙箱参数运行，可以阅读和修改仓库文件、执行测试并流式返回助手文本。页面或 HTTP 连接关闭时，服务会停止对应的 Codex 进程组；Codex 响应不会把原始 stderr、工具事件和服务器绝对路径发送到浏览器。

在前台运行时按 `Ctrl+C` 停止服务。停止管理服务不会删除已存在的 Zellij Session。

### 后台服务脚本

使用脚本构建并在后台启动服务，workspace 路径为必填参数：

```bash
npm run service:start -- /实际/workspace/路径
```

停止后台服务：

```bash
npm run service:stop
```

统一重启管理服务、Zellij Web、当前 code-viewer 和 OpenVSCode：

```bash
npm run service:restart -- /实际/workspace/路径
```

主页也提供“重启后台服务”按钮。重启会先优雅停止管理服务和 viewer，再校验并清理由本项目启动的 Zellij Web、OpenVSCode 进程组、PID 文件和配置端口，随后使用同一 workspace 重新拉起；不会删除 Zellij Session。若端口属于无法验证的其他进程，脚本会失败而不会误杀。网页触发的详细输出写入 `data/service-restart.log`。

脚本把 PID 写入 `data/terminal-web.pid`，把标准输出和错误日志写入 `data/terminal-web.log`。统一重启还维护 `data/zellij-web.pid` 和 `data/openvscode.pid`；停止脚本只停止该 PID 对应的管理服务，并在最多 10 秒的优雅退出等待期显示百分比和耗时进度；超时后会明确提示并发送 `SIGKILL`，不会删除 Zellij Session。

`npm install` 会安装项目依赖 `@youtyan/code-viewer@0.10.0`，服务端直接解析项目本地可执行文件，不要求系统单独安装 code-viewer，也不依赖全局 PATH。安装过程还会检查项目路径和 PATH 中的 Zellij；若都不存在，会把官方固定版本 `0.44.3` 安装到 `data/bin/zellij`。后端启动时会再次执行 Zellij 检查，因而使用 `--ignore-scripts` 安装后仍能自动补齐。

后端首次启动还会检查配置的 Zellij Web 证书和私钥。两者都不存在时自动创建自签名证书；已有证书必须有效、与私钥匹配，并且 Subject Alternative Name 覆盖两个入口使用的主机名或 IP，才会直接复用。Zellij Web 配置中的 `web_server_cert` 和 `web_server_key` 必须指向同一组文件，管理页面复用该证书提供 HTTPS。两个入口使用同一 HTTPS 主机，浏览器才能在打开 Session 时发送 Zellij Web 的 `SameSite=Strict` 记住登录 Cookie。

配置中的 `zellij.configFile` 必须指向终端用户实际使用的默认 Zellij `config.kdl`。服务启动时会确保其中包含 `web_sharing "on"`，因此之后使用 `zellij --session <name>` 创建的新 Session 可以从 Zellij Web 打开。已经运行的旧 Session 不会自动改变共享状态，需要停止后重新创建。

`zellij.webTokenDatabaseFile` 必须指向同一 Zellij 用户的数据目录中的 `tokens.db`。项目使用固定版本数据库契约生成唯一 Token，规避 Zellij `0.44.3` 删除 Token 后默认名称冲突的问题。

若 `config.json` 尚未包含 `zellij.webToken`，后端首次启动会创建专用 Zellij Web Token，并以 `name`、`value` 形式写入配置，同时把配置文件权限设为 `0600`。主页显示 Token 并提供复制、删除和重新创建按钮；Token 不写入普通日志。

浏览器直接访问 `publicBaseUrl`，无需登录。必须通过防火墙确保该地址只允许 VPN/公司内网访问。

## 验证

```bash
npm run typecheck
npm test
npm run probe:mvp0
npm run probe:mvp1
```

本机 Zellij Web 探测可使用：

```bash
ZELLIJ_WEB_BASE_URL=https://127.0.0.1:8021 ZELLIJ_WEB_INSECURE=1 npm run probe:mvp0
```

每个 Git 仓库固定对应一个服务端命名的 Zellij Session：不存在时可创建，存在时可通过管理服务同源 `/zellij/<session>` 打开或删除。仓库条目同时提供“code-viewer”“编辑代码”和“与 Codex 对话”；code-viewer `0.10.0` 使用 `127.0.0.1:8022`，浏览器通过管理服务的同源 viewer URL 访问；当前为单活动实例，切换仓库时会停止旧实例，不会公开 localhost 上游端口。“编辑代码”会打开后端根据管理服务 HTTPS 地址和已校验 repository 目录生成的 `/openvscode/` URL，并通过 `folder` 参数自动打开该仓库。OpenVSCode 使用相同 workspace root、只监听 localhost，Codex Webview 因此可在非 localhost 浏览器地址中运行于安全上下文。“与 Codex 对话”由主服务提供流式页面和 API，并在已校验 repository 中使用固定参数运行 Codex CLI。外部只需开放管理服务端口。
