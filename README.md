# Terminal Web

当前实现覆盖 MVP-0 外部工具验证和 MVP-1 只读管理。管理入口监听 `0.0.0.0`，通过服务器 IP 提供 HTTPS；workspace 自身为 Git repository 时只显示自身，否则递归发现各级子目录中的 Git repository，并以扁平列表展示。code-viewer 上游仍限制在 localhost。

## 环境

- Node.js `26.x`（当前基线 `26.5.1`）
- Zellij `0.44.3`
- code-viewer `0.10.0`

## 配置

复制 `config.example.json` 为 `config.json`，把 `publicBaseUrl` 改为实际 HTTPS 访问地址，例如 `https://192.168.1.20:8024`，并把 `zellijWebBaseUrl` 改为同一主机上的 Zellij Web HTTPS 地址，例如 `https://192.168.1.20:8021`。

准备权限受限的目录 ID secret。管理页面不需要用户名、密码或 TLS 证书：

```bash
mkdir -p data
openssl rand -base64 32 > data/directory-id.secret
chmod 600 data/directory-id.secret
```

必须通过防火墙只允许 VPN/公司内网访问管理端口。

## 构建与启动

### 首次准备

推荐使用交互式初始化脚本。它会安装 nvm 和 Node.js 26、安装项目依赖及固定版本 Zellij、创建 `config.json`、配置 Zellij Web，并生成目录 ID secret。脚本只负责初始化配置，不会启动管理服务：

```bash
scripts/init.sh
```

也可以传入参数进行无人值守初始化：

```bash
scripts/init.sh --host 192.168.1.20 --service-port 8024 --zellij-port 8021 --viewer-port 8022 --non-interactive
```

使用 `scripts/init.sh --help` 查看全部参数。脚本不会配置主机防火墙；仍需只允许 VPN 或公司内网访问管理端口和 Zellij Web 端口。

初始化完成后，显式启动后台服务：

```bash
npm run service:start -- /实际/workspace/路径
```

HTTPS 证书和 Zellij Web Token 会在服务首次启动时初始化。

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

- `publicBaseUrl` 必须使用 HTTPS，例如 `https://192.168.1.20:8024`。
- `zellijWebBaseUrl` 必须使用 HTTPS，并与 `publicBaseUrl` 使用相同主机名或 IP，例如 `https://192.168.1.20:8021`。
- `zellij.configFile` 和 `zellij.webTokenDatabaseFile` 必须指向运行服务用户的 Zellij 配置及数据目录。

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

服务启动后，在浏览器访问 `config.json` 中配置的 `publicBaseUrl`。默认监听端口为 `8024`，例如 `https://192.168.1.20:8024`。管理页面无需登录，但必须通过防火墙限制为仅允许 VPN 或公司内网访问。

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

脚本把 PID 写入 `data/terminal-web.pid`，把标准输出和错误日志写入 `data/terminal-web.log`。停止脚本只停止该 PID 对应的管理服务，不删除 Zellij Session。

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

每个 Git 仓库固定对应一个服务端命名的 Zellij Session：不存在时可创建，存在时可直接打开或删除。仓库条目同时提供“打开 code-viewer”；code-viewer `0.10.0` 使用 `127.0.0.1:8022`，浏览器通过管理服务的同源 viewer URL 访问；当前为单活动实例，切换仓库时会停止旧实例，不会公开 localhost 上游端口。
