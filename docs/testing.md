# 测试计划

测试范围随里程碑逐步扩展。默认测试不能依赖真实 Zellij、code-viewer、网络端口或用户主目录；外部集成通过 adapter 和 fake process 测试。真实工具测试放在单独的 integration suite 中。

## 测试分层

### 单元测试

覆盖纯类型、schema、路径边界、输出解析、状态写入、端口分配和状态机。

### 服务测试

使用 fake filesystem 或受控临时目录，以及 fake Zellij/code-viewer adapter，验证服务层完整流程和并发行为。

### 路由测试

通过 Fastify injection 验证认证、请求 schema、状态码、错误格式和响应脱敏。

### 集成测试

使用已固定版本的真实 Zellij 和 code-viewer。测试必须使用唯一名称、临时目录和受控端口，并在 `finally` 中清理资源。

### 前端测试

使用组件测试覆盖请求状态和交互；关键浏览器流程使用 Playwright 覆盖新标签页、轮询和响应式布局。

## MVP-0：工具探测

1. 临时 KDL layout 可以通过 `attach --create-background` 创建 Session。
2. 允许命令在目标工作目录启动。
3. `list-sessions --short` 可以精确发现创建的 Session。
4. `delete-session --force` 可以删除目标 Session，不影响其他 Session。
5. Zellij Web 的目标 URL 可以打开指定 Session。
6. 默认配置为 `web_sharing "on"` 时，使用 `zellij --session` 新建的 Session 能完成 Zellij Web 登录、WebSocket 附加并收到终端数据。
7. code-viewer 使用显式端口启动，并输出匹配的 `GDP_LISTEN_URL`。
8. code-viewer 根路径在启动后返回 `200-399`。
9. HTTP 静态资源和重定向通过 `/viewer/<id>/` 工作。
10. WebSocket upgrade 通过 `/viewer/<id>/` 工作。
11. Cookie Path 和 Location 重写不会逃出实例前缀。

## MVP-1：只读管理

### 配置与就绪

1. 未传 `--workspace-root` 时启动失败。
2. 不存在、不可读或非目录的 root 被拒绝。
3. root 自身为符号链接时保存其真实路径。
4. directory ID secret 缺失或权限不安全时 ready 失败。
5. 工具版本错误时 health 成功、ready 失败且写操作被拒绝。
6. health 不调用外部工具。
7. ready 响应不泄露绝对路径或原始命令输出。
8. 项目托管或 PATH 中存在正确版本 Zellij 时不下载。
9. 两处都缺少 Zellij 时只从固定官方 URL 下载 `0.44.3`，验证版本后安装到项目路径并设置 `0755`。
10. 已存在错误版本时不静默替换，ready 报告失败。
11. Zellij Web 证书和私钥都存在且有效时直接复用。
12. 两者都不存在时创建包含配置主机 SAN 的证书，证书和私钥权限分别为 `0644`、`0600`。
13. 证书处于部分状态、无效、过期、密钥不匹配或私钥权限过宽时启动失败且不覆盖文件。
14. Zellij 配置缺少或关闭 Web Sharing 时原子写入 `web_sharing "on"` 并保留文件权限。
15. Zellij 配置已经启用 Web Sharing 时不重复改写。

### Zellij Web Token

1. 首次启动创建专用 Token，并把 Token 名称和值一起写入 `config.json`。
2. Token 数据库只保存 SHA-256 哈希、唯一名称和只读标志，不保存明文值，权限为 `0600`。
3. 写入 Token 后 `config.json` 权限为 `0600`，更新使用同目录临时文件和原子替换。
4. 配置中保存的 Token 名称仍存在于 Zellij 时直接复用名称和值。
5. 配置中的 Token 名称已被撤销时自动创建并保存替代名称和值。
6. 专用 API 和主页 Token 区域显示名称和值，并可复制 Token 值。
7. 删除操作使用配置保存的名称调用 `web --revoke-token <name>`，成功后同时移除名称和值。
8. 重新创建先持久化新名称和值，再按旧名称撤销旧 Token。
9. 普通日志、错误响应和其他 API 不包含 Token 值或可能含 Token 的原始命令输出。

### Session 查询

1. `list-sessions --short` 的合法名称被解析。
2. 非法输出行被忽略并记录 warning。
3. managed 元数据正确合并。
4. external Session 的未知字段为 `null`。
5. 不存在的历史 managed 元数据不出现在响应中。
6. 列表按名称稳定排序。
7. webUrl 使用编码后的名称和配置基础 URL。

### 目录浏览

1. workspace 自身是 Git repository 时只返回 workspace，不读取子目录。
2. workspace 不是 Git repository 时递归返回任意深度的 Git repository。
3. 找到 Git repository 后不继续探测其内部嵌套目录。
4. `.git` 目录和 `.git` 文件都识别为 Git repository。
5. 只有 Node、Python、Rust、Go 或 Java marker 而没有 `.git` 的目录不返回。
6. 已返回 Git repository 的多 marker 顺序稳定。
7. 隐藏目录和默认忽略目录不显示。
8. `..` 无法逃出 workspace root。
9. 指向 root 外部的符号链接不显示。
10. 断链、`EACCES` 和扫描期间的 `ENOENT` 不使整个列表失败。
11. workspace 删除后返回 `404 DIRECTORY_NOT_FOUND`。
12. 目录 ID 在相同 secret 下跨重启稳定。
13. workspace 非 Git repository 且递归扫描超过 1000 个可见目录时返回 `422 DIRECTORY_TOO_LARGE`，不截断。
14. 条目按相对路径稳定排序。
15. API 拒绝 `parentId` 和任意路径查询参数。

### 访问和页面

1. 页面和 API 不要求用户凭据。
2. 服务可以绑定 `0.0.0.0`，并通过配置的 HTTP IP 入口访问。
3. 管理入口使用 HTTPS 时被拒绝，Zellij Web 不使用 HTTPS 时被拒绝。
4. 页面不显示或请求用户身份。
5. Session 打开链接使用新标签页和 `noopener noreferrer`。
6. 桌面和移动尺寸无文字溢出和控件重叠。
7. 页面隐藏时停止轮询，恢复时立即刷新。

## MVP-2：Session 操作

1. repository 始终生成稳定、合法的固定 Session 名称；唯一目录名兼容旧页面默认名称，同名目录追加稳定短后缀。
2. 创建请求提交 Session 名称或其他额外字段时被拒绝。
3. 非 repository 目录返回 `422`。
4. 创建前重新执行真实路径边界校验。
5. 外部进程参数不经过 Shell 展开。
6. 前端 command 只能映射到预定义 `codex` layout。
7. layout 文件权限为 `0600`，成功和失败后都被删除。
8. 同一 repository 并发创建只执行一次外部命令。
9. repository 对应 Session 已存在时返回 `200` 和已有 Session，不执行创建命令。
10. 创建命令成功但查询不到 Session 时不写 managed 元数据。
11. 创建成功但状态写入失败时返回 `STATE_WRITE_FAILED` 并重新查询补偿。
12. 创建超时后释放互斥锁和临时文件。
13. 删除不存在 Session 返回 `404 SESSION_NOT_FOUND`。
14. 删除参数精确使用 `delete-session --force <name>`。
15. 删除后仍能查询到 Session 时不删除元数据。
16. 删除确认要求输入准确名称。
17. 跨 Origin 写请求返回 `403`。
18. 审计日志记录用户、动作、资源 ID、结果和 requestId，不记录 Token。
19. 管理服务退出不删除 Session。

## MVP-3：Viewer 管理

当前首版仓库页面覆盖：点击“打开 code-viewer”会先同步打开空白标签页，再通过 API 启动或复用 localhost:8022 的 code-viewer，并导航到同源 viewer 地址；切换仓库会停止旧实例。repository 没有对应 Session 时显示创建按钮，已有时显示安全打开链接和删除按钮。“打开 code-viewer”旁边显示“编辑代码”链接，安全地在新标签页打开后端为该 repository 生成的 OpenVSCode URL；URL 的 `folder` 参数必须等于重新执行真实路径和 workspace containment 校验后的 repository 目录，前端不得自行拼接路径。

1. 请求额外字段和非法 ID 被拒绝。
2. 非 repository 或越界目录无法启动 viewer。
3. 同一目录的并发请求只产生一个进程。
4. 健康实例返回 `200` 并被复用。
5. 新实例返回 `201`。
6. 固定端口 8022 被占用时启动失败且清理进程状态。
7. code-viewer 只绑定 localhost。
8. `GDP_LISTEN_URL` 主机或端口不匹配时启动失败。
9. stdout 和 stderr 缓冲不会超过每项 64 KiB。
10. 启动超时后进程组和端口记录被清理。
11. 异常退出后实例和端口记录被清理。
12. 停止先发送 `SIGTERM`，超时后发送 `SIGKILL`。
13. 切换 repository 时先停止旧实例再启动新实例。
14. 服务关闭时停止当前 viewer 进程组。
15. 单实例模式不会同时保留两个上游进程。
16. 非 running 实例代理返回 `503 VIEWER_NOT_READY`。
17. 首次 viewer HTTP 路径前缀被正确移除。
18. 响应设置 HttpOnly、SameSite=Strict viewer cookie。
19. 根绝对静态资源、API 和 `/events` SSE 根据 cookie 正确转发。
20. Host、Origin 和 Referer 正确重写，成功请求更新最后访问时间。
21. viewer 代理不要求用户凭据，并由部署网络边界限制访问。
22. 弹窗被阻止时不发送启动请求。
23. 启动失败时空白标签页被关闭。
24. 轮询不覆盖 starting 和 stopping 状态。

## MVP-4：生产化

1. 空闲 viewer 在超时后停止。
2. 活跃 viewer 不被回收。
3. 状态 JSON 使用两个空格和尾随换行。
4. 状态写入经过临时文件、fsync、rename 和父目录 fsync。
5. 状态文件损坏时保留原文件并禁止写操作。
6. 不支持的未来 schema 版本导致 ready 失败。
7. 状态更新并发执行时不会丢失数据。
8. PID 重用不会导致终止无关进程。
9. 重启后不接管历史 viewer，并清理已确认的遗留进程。
10. `SIGTERM` 时停止接收请求并等待状态写入。
11. 优雅退出停止 viewer，但不删除 Zellij Session。
12. 请求频率和 viewer 启动频率限制生效。
13. 防火墙规则只允许 VPN/公司内网访问管理端口。
14. 日志和错误响应不包含 Token、绝对路径或命令输出。
15. systemd 重启后服务自动恢复 ready 状态。
16. 停止脚本在 10 秒优雅退出等待期显示百分比和耗时进度，提前退出和升级 `SIGKILL` 都有明确结果提示。
17. 同源重启请求返回 `202`，额外字段和跨 Origin 请求被拒绝。
18. 重启先优雅停止管理服务和当前 viewer，再停止 Zellij Web 与 OpenVSCode；Zellij Session 保持存在。
19. 只有命令路径、固定参数和端口均匹配本项目的遗留进程会被终止；无关进程占用任一配置端口时重启失败且不误杀。
20. OpenVSCode 和 code-viewer 的独立进程组及子进程被清理，PID 文件以 `0600` 重建，配置端口不残留旧监听者。
21. 前端二次确认后发送固定空请求，重启期间禁用按钮，并在观察到服务离线后等待恢复再刷新。

## 完成标准

每个任务至少通过：

1. 受影响模块的单元或服务测试。
2. 受影响路由的 schema 和错误测试。
3. TypeScript 类型检查。
4. 若涉及真实外部行为，对应的可选集成测试。

不得用全量测试通过替代缺失的行为级断言，也不得因无关失败扩大任务范围。
