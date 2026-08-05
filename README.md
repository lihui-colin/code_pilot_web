# CodePilot Web

CodePilot Web 用于在浏览器中管理 workspace 下的 Git 仓库、Zellij Session、code-viewer、OpenVSCode 和 Codex 对话。

## 安装

进入项目目录，运行：

```bash
./init.sh
```

脚本会引导你填写浏览器访问地址和端口，并自动安装 Node.js 26、项目依赖、Zellij 和 OpenVSCode Server，同时生成配置与 HTTPS 证书。

无人值守安装示例：

```bash
./init.sh \
  --host 192.168.1.20 \
  --service-port 8020 \
  --zellij-port 8021 \
  --viewer-port 8022 \
  --openvscode-port 8023 \
  --non-interactive
```

查看全部安装参数：

```bash
./init.sh --help
```

## 启动服务

默认使用当前项目目录作为 workspace：

```bash
./start_servers.sh
```

也可以指定其他 workspace：

```bash
./start_servers.sh /实际/workspace/路径
```

启动完成后，终端会显示浏览器访问地址和日志文件位置。

## 停止服务

```bash
./stop_servers.sh
```

停止操作会关闭管理服务、Codex CLI、code-viewer、Zellij Web 和 OpenVSCode，但不会删除已有的 Zellij Session。

## 注意事项

- 管理页面没有应用层登录，请通过防火墙限制为仅允许 VPN 或公司内网访问。
- Zellij Web、code-viewer 和 OpenVSCode 的上游端口只监听 localhost，无需对外开放。
- 使用浏览器 Codex 对话前，请确保运行服务的用户已经安装并登录 `codex` CLI。

## 开发验证

```bash
npm run typecheck
npm test
```
