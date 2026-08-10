# CodePilot Web

CodePilot Web 用于在浏览器中管理 workspace 下的 Git 仓库、Zellij Session、code-viewer、OpenVSCode 和 Codex 对话。

## 安装

启动服务前依次完成依赖安装、配置初始化和服务构建。

### 步骤 1：安装依赖

使用当前终端默认的 Node.js 和 npm 安装项目依赖，并通过 `npm link` 注册 `codepilot-server` 命令：

```bash
source ./scripts/install_deps.sh
```

脚本不会安装 NVM、切换 Node.js 版本或修改 NVM 默认版本。执行前请确保当前终端中的 `node` 和 `npm` 可用。使用 `source` 执行后，`codepilot-server` 会在当前终端立即生效。也可以直接执行安装脚本：

```bash
./scripts/install_deps.sh
```

直接执行不会修改当前终端环境；`codepilot-server` 会注册到当前 Node.js 对应的 npm 全局目录。

### 步骤 2：初始化配置

初始化配置、固定版本的 Zellij 和 OpenVSCode Server、目录 ID secret 与 HTTPS 证书：

```bash
codepilot-server init
```

初始化命令会把安装时配置的 host 写入 `config.json` 的 `publicBaseUrl`，把服务端口写入 `listenPort`。需要升级或重新安装依赖时，可以单独再次运行 `./scripts/install_deps.sh`，无需覆盖运行配置。

初始化时可以输入以下配置参数：

| 参数 | 默认值 | 写入配置 | 说明 |
| --- | --- | --- | --- |
| `--host` | 无，必填 | `publicBaseUrl` | 浏览器可访问的宿主机 IP 或域名，也用于 HTTPS 证书 SAN；不要填写容器内部 IP |
| `--listen-host` | `0.0.0.0` | `listenHost` | CodePilot Web 的监听地址 |
| `--port` | 无，必填 | `listenPort`、`publicBaseUrl` | CodePilot Web HTTPS 端口 |
| `--zellij-port` | `5021` | `zellij.webPort` | 本机 Zellij Web 上游端口 |
| `--viewer-port` | `5022` | `viewerPortRange.start/end` | 本机 code-viewer 上游端口 |
| `--openvscode-port` | `5023` | `openVSCode.port` | 本机 OpenVSCode 上游端口 |
| `--config` | `config.json` | 初始化目标 | 指定要创建或覆盖的配置文件 |
| `--non-interactive` | 关闭 | 不写入 | 不进行交互提问，缺少必填值时直接失败 |

不使用 `--non-interactive` 时，命令会询问必填的宿主机 host、服务端口和其他可选端口。`--host` 必须填写 VPN 或局域网浏览器实际访问的宿主机地址，即使初始化命令运行在容器内，也不能填写容器内部 IP。可选端口直接按 Enter 使用表中的默认值。所有端口必须互不相同。

无人值守安装示例：

```bash
codepilot-server init \
  --host 192.168.1.20 \
  --listen-host 0.0.0.0 \
  --port 8020 \
  --zellij-port 5021 \
  --viewer-port 5022 \
  --openvscode-port 5023 \
  --non-interactive
```

查看全部安装参数：

```bash
codepilot-server init --help
```

### 步骤 3：构建服务

```bash
npm run build
```

## 启动服务

构建或安装 npm 包后，使用单一 Node.js 命令管理后台服务。后台默认监听 `0.0.0.0`；`--host` 是浏览器访问的 IP 或域名，同时用于 Zellij HTTPS 证书校验和签发：

```bash
codepilot-server start --host 192.168.1.20 --port 8020 --workspace /实际/workspace/路径
```

省略 `--host` 和 `--port` 时，分别沿用 `config.json` 中 `publicBaseUrl` 的主机和 `listenPort`：

```bash
codepilot-server start --workspace /实际/workspace/路径
```

默认读取当前目录的 `config.json`。也可以通过 `--config` 指定其他配置文件。查看状态和前台运行：

```bash
codepilot-server status
codepilot-server run --host 192.168.1.20 --port 8020 --workspace /实际/workspace/路径
```

## 停止服务

```bash
codepilot-server stop
```

停止操作会关闭管理服务、Codex CLI、code-viewer、Zellij Web 和 OpenVSCode，但不会删除已有的 Zellij Session。

`codepilot-server restart` 会执行同样的后台进程清理，但只重新启动管理服务并确保 Zellij Web 可用。Codex、code-viewer 和 OpenVSCode 不会自动恢复，已有 Zellij Session 保持不变。

## 注意事项

- 管理页面没有应用层登录，请通过防火墙限制为仅允许 VPN 或公司内网访问。
- Zellij Web、code-viewer 和 OpenVSCode 的上游端口只监听 localhost，无需对外开放。
- 使用浏览器 Codex 对话前，请确保运行服务的用户已经安装并登录 `codex` CLI。

## 开发验证

```bash
npm run typecheck
npm test
```
