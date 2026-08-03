# ADR-004：code-viewer 单实例兼容代理

- 状态：Accepted
- 日期：2026-08-02

## 背景

ADR-002 要求 code-viewer 使用同源 `/viewer/<viewer_id>/` 代理，并在固定版本无法支持该结构时暂停实现。实际验证确认 code-viewer `0.10.0` 的 HTML、页面导航、API 和 SSE 广泛使用站点根绝对路径，且没有 base-path 配置。

产品现在要求每个 Git repository 提供可用的“浏览代码”按钮，同时既不能公开 localhost 上游端口，也不能加入脆弱的 HTML/JavaScript 正文改写。

## 决策

在 code-viewer `0.10.0` 期间采用单活动实例兼容模式：

1. code-viewer 固定监听 `127.0.0.1:8022`，浏览器仍只访问管理服务 HTTP 入口。
2. `GET /viewer/<viewer_id>/` 去除实例前缀后代理到上游 `/`，并设置仅 HttpOnly、SameSite=Strict 的当前 viewer ID cookie。
3. code-viewer 随后的根绝对资源、API、导航和 `/events` SSE 请求，由该 cookie 路由到当前活动实例。
4. 管理首页 `/`、管理 API 和已登记的管理前端静态资源保持由管理应用处理。
5. 切换 repository 时先停止旧实例，再启动新实例；旧标签页随后不再代表原 repository。
6. 代理核心使用 Fastify 官方 `@fastify/reply-from`，只重写请求 Host、Origin 和 Referer 以及设置路由 cookie，不修改 HTML、CSS 或 JavaScript 正文。

## 后果

- 满足仓库页面直接打开 code-viewer 的需求，上游端口仍不对 VPN 网络公开。
- 静态资源和 SSE 可以流式转发，不需要 code-viewer 提供 base path。
- 当前不能同时使用多个 repository 的 code-viewer；多实例能力仍需上游支持 base path 或另一个新增 ADR。
- ADR-002 的通用多实例结论仍然有效，本 ADR 只定义固定版本下的单实例兼容路径。
