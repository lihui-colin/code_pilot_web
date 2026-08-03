# Terminal Web

当前实现覆盖 MVP-0 外部工具验证和 MVP-1 只读管理。管理入口监听 `0.0.0.0`，通过服务器 IP 提供 HTTP；workspace 自身为 Git repository 时只显示自身，否则递归发现各级子目录中的 Git repository，并以扁平列表展示。code-viewer 上游仍限制在 localhost。

## 环境

- Node.js `26.x`（当前基线 `26.5.1`）
- Zellij `0.44.3`
- code-viewer `0.10.0`

## 配置

复制 `config.example.json` 为 `config.json`，把 `publicBaseUrl` 改为实际 HTTP 访问地址，例如 `http://192.168.1.20:8024`，并把 `zellijWebBaseUrl` 改为 Zellij Web 的 HTTPS 地址，例如 `https://192.168.1.20:8021`。

准备权限受限的目录 ID secret。管理页面不需要用户名、密码或 TLS 证书：

```bash
mkdir -p data
openssl rand -base64 32 > data/directory-id.secret
chmod 600 data/directory-id.secret
```

必须通过防火墙只允许 VPN/公司内网访问管理端口。

## 构建与启动

确保使用 Node 26，然后安装项目依赖：

```bash
nvm use
npm install
npm run build
npm start
```

项目的默认 workspace 已设置为 `/data01/home/lihui/projects/xhquant_projects/`。直接运行编译入口时仍需显式传入：

```bash
node dist/server.js --config config.json --workspace-root /data01/home/lihui/projects/xhquant_projects/
```

`npm install` 会安装项目依赖 `@youtyan/code-viewer@0.10.0`，服务端直接解析项目本地可执行文件，不要求系统单独安装 code-viewer，也不依赖全局 PATH。安装过程还会检查项目路径和 PATH 中的 Zellij；若都不存在，会把官方固定版本 `0.44.3` 安装到 `data/bin/zellij`。后端启动时会再次执行 Zellij 检查，因而使用 `--ignore-scripts` 安装后仍能自动补齐。

后端首次启动还会检查配置的 Zellij Web 证书和私钥。两者都不存在时自动创建自签名证书；已有有效文件时直接复用。Zellij Web 配置中的 `web_server_cert` 和 `web_server_key` 必须指向同一组文件。管理页面继续使用 HTTP，只有 Zellij Web 使用独立 HTTPS。

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
