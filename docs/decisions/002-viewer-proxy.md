# ADR-002：code-viewer 统一子路径代理

- 状态：Accepted
- 日期：2026-08-02

## 背景

每个 repository 可能启动独立 code-viewer。直接公开每个实例端口会扩大防火墙范围，并导致 URL 生命周期和端口管理复杂化。

管理页面和 viewer 需要保持同源，且 viewer 同时使用普通 HTTP、静态资源和 WebSocket。

## 决策

code-viewer 只监听 `127.0.0.1` 的受控端口。管理服务通过 `/viewer/<viewer_id>/` 提供统一 HTTP 入口，不增加应用登录。

代理移除实例前缀，重写 Host、Origin、Location 和 Cookie Path，并支持 WebSocket upgrade。

如果固定版本的 code-viewer 无法在该结构下正常加载资源或连接 WebSocket，暂停 MVP-3，先调整同源代理结构。不得自动退化为向 VPN 网络公开端口池。

## 后果

- 外部只需要一个受 VPN/防火墙保护的管理入口。
- 上游端口不进入公开防火墙规则。
- 必须在 MVP-0 对资源路径、重定向、Cookie 和 WebSocket 做真实集成验证。
- 代理实现必须使用成熟库，并具有针对重写行为的集成测试。

## MVP-0 验证结果

2026-08-02 对 code-viewer `0.10.0` 的真实探测发现：

- HTML、静态资源、页面导航和 API 调用广泛使用站点根绝对路径。
- 实时更新使用 `/events` Server-Sent Events，未发现 WebSocket endpoint。
- 仅移除 `/viewer/<viewer_id>` 前缀的代理无法保持浏览器请求位于实例前缀内。

依据本 ADR，MVP-3 保持暂停。后续若选择升级 code-viewer、引入上游支持的 base path，或修改同源路由结构，应新增 ADR 并同步更新 `docs/contracts.md`，而不是在代理中加入脆弱的响应正文替换。

单活动实例的兼容路由结构现由 [ADR-004](004-single-viewer-compatibility-proxy.md) 定义；本 ADR 对通用多实例子路径代理的结论保持不变。
