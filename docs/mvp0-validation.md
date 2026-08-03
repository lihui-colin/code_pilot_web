# MVP-0 外部工具验证记录

验证日期：2026-08-02

## 运行方式

使用 Node.js 26.5.1，并显式提供运行中的 Zellij Web 地址：

```bash
PATH=/home/lihui/.nvm/versions/node/v26.5.1/bin:$PATH \
ZELLIJ_WEB_BASE_URL=https://127.0.0.1:8021 \
ZELLIJ_WEB_INSECURE=1 \
node scripts/probe-mvp0.mjs /home/lihui/terminal_web
```

`ZELLIJ_WEB_INSECURE=1` 仅用于本机自签名证书探测，不属于正式服务配置。

探测脚本会创建唯一临时 Session、临时 KDL layout、命令包装器和临时 code-viewer 实例，并在 `finally` 中清理自身资源。运行前存在的 Zellij Session 不应被删除。

## 结果

共 14 项：12 项通过，2 项失败。

通过项包括：

- 三个固定版本基线。
- Zellij 后台 Session 创建、目标目录、查询和定向删除。
- Zellij Web Session URL。
- code-viewer 显式端口、`GDP_LISTEN_URL` 和根健康检查。
- 代理显式前缀资源转发、SSE 转发，以及 Location/Cookie Path 重写规则。

失败项：

1. code-viewer 页面包含 16 个根绝对资源或导航 URL，例如 `/style.css`、`/app.js`、`/history`。浏览器从 `/viewer/<id>/` 打开页面后会请求站点根路径，无法确定应路由到哪个 viewer 实例。
2. code-viewer `0.10.0` 前端使用 `new EventSource("/events")`，未提供 WebSocket endpoint，当前 WebSocket 验收项无法执行。

## 阶段结论

统一子路径代理未通过。按照 ADR-002，不公开 code-viewer 上游端口，不进入 MVP-3，也不通过修改第三方响应正文临时伪造 base path 支持。MVP-1 与 MVP-2 不受该阻塞影响。
