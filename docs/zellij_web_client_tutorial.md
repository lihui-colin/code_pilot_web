# Zellij Web Client 部署教程（HTTPS、端口配置、证书、滚动缓存、多 Session 管理）

## 1. 环境准备

查看版本：

```bash
zellij --version
```

推荐使用 Zellij 0.44.x+。

检查配置：

```bash
zellij setup --check
```

默认配置：

```text
~/.config/zellij/config.kdl
```

---

## 2. 创建 HTTPS 证书

当监听非本地地址：

```kdl
web_server_ip "0.0.0.0"
```

必须配置 HTTPS。

## 创建证书目录

```bash
mkdir -p ~/.config/zellij/certs
cd ~/.config/zellij/certs
```

## 生成自签证书

假设服务器 IP：

```text
10.30.0.24
```

执行：

```bash
openssl req \
-newkey rsa:4096 \
-x509 \
-days 3650 \
-nodes \
-keyout zellij.key \
-out zellij.crt \
-subj "/CN=10.30.0.24"
```

生成：

```
zellij.crt
zellij.key
```

---

# 3. Zellij Web 配置

编辑：

```bash
vim ~/.config/zellij/config.kdl
```

加入：

```kdl
web_server true

web_server_ip "0.0.0.0"

web_server_port 8021

web_server_cert "/home/lihui/.config/zellij/certs/zellij.crt"

web_server_key "/home/lihui/.config/zellij/certs/zellij.key"
```

---

# 4. 配置滚动历史

默认终端历史较小。

针对 Codex CLI、日志分析等场景：

```kdl
scroll_buffer_size 100000
```

或者：

```kdl
scroll_buffer_size 500000
```

注意：

该配置只影响新创建的 pane/session。

旧 session 不会自动更新。

---

# 5. 启动 Zellij Web Client

生成 Token：

```bash
zellij web --create-token
```

保存输出的 token。

启动：

```bash
zellij web
```

查看状态：

```bash
zellij web --status
```

查看端口：

```bash
ss -lntp | grep 8021
```

---

# 6. 创建 Session

创建：

```bash
zellij --session codex_1
```

启动 Codex：

```bash
codex
```

退出但保持 session：

```
Ctrl+p
d
```

查看：

```bash
zellij list-sessions
```

---

# 7. 浏览器访问

访问：

```
https://10.30.0.24:8021
```

输入 Token。

进入指定 session：

```
https://10.30.0.24:8021/codex_1
```

---

# 8. 修改配置后的注意事项

例如修改：

```kdl
scroll_buffer_size 100000
```

旧 session：

```
codex_1
```

仍然使用旧 buffer。

需要重新创建：

```bash
zellij delete-session codex_1

zellij --session codex_1
```

---

# 9. 多 Agent 推荐结构

```
Zellij Web :8021

sessions:

codex-qwen3
    |
    codex

codex-review
    |
    codex

quant-analysis
    |
    python

paper-reading
    |
    codex
```

浏览器：

```
https://server:8021/codex-qwen3
```

---

# 10. systemd 自动启动

创建：

```bash
sudo vim /etc/systemd/system/zellij-web.service
```

内容：

```ini
[Unit]
Description=Zellij Web Client
After=network.target

[Service]
User=lihui
Environment=HOME=/home/lihui
ExecStart=/usr/local/bin/zellij web
Restart=always

[Install]
WantedBy=multi-user.target
```

启动：

```bash
sudo systemctl daemon-reload

sudo systemctl enable zellij-web

sudo systemctl start zellij-web
```

查看：

```bash
systemctl status zellij-web
```

---

# 11. 推荐架构

```
Browser
   |
 HTTPS
   |
 Nginx
   |
 +----------------+
 |                |
code-server    zellij-web
 :8020           :8021

                |
          Zellij Sessions

       +---------+---------+
       |         |         |
    Codex    Qwen3    Analysis
```

---

# 12. 常用命令

| 功能         | 命令                         |
| ------------ | ---------------------------- |
| 检查配置     | `zellij setup --check`       |
| 生成 Token   | `zellij web --create-token`  |
| 启动 Web     | `zellij web`                 |
| 停止 Web     | `zellij web --stop`          |
| 查看状态     | `zellij web --status`        |
| 查看 Session | `zellij list-sessions`       |
| 创建 Session | `zellij --session name`      |
| 删除 Session | `zellij delete-session name` |
