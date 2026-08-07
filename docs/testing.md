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
6. 主页默认隐藏 Token 名称、值及管理操作；打开 Token 管理侧边栏后显示名称和值并可复制，侧边栏可通过关闭按钮、遮罩和 Esc 关闭。
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
16. “添加文件夹”从文件系统根目录开始，只通过 `folder_` 不透明 ID 逐层浏览，不接受查询或请求体中的绝对路径。
17. 目录选择器只返回可读子目录，标记其中包含 `.git` 的目录，并拒绝选择非 Git 目录。
18. workspace 外 Git repository 被持久化、合并到扁平列表并标记为 `manual`，重启后恢复。
19. 移除手动 repository 只更新状态记录，不删除文件或 Session；workspace 自动扫描条目不能通过该接口移除。
20. 手动 repository 的 Session、viewer、OpenVSCode 和 Codex 操作前重新执行真实路径、Git 标识和来源边界校验。

### 访问和页面

1. 页面和 API 不要求用户凭据。
2. 服务可以绑定 `0.0.0.0`，并通过配置的 HTTP IP 入口访问。
3. 管理入口和 `publicBaseUrl` 必须使用 HTTPS；浏览器不直接访问 Zellij Web 上游端口。
4. 页面不显示或请求用户身份。
5. Session 打开链接使用新标签页和 `noopener noreferrer`。
6. 桌面和移动尺寸无文字溢出和控件重叠。
7. 页面隐藏时停止轮询，恢复时立即刷新。
8. Session URL 使用主服务同源 `/zellij/open/<session>`，不包含 Zellij 上游端口；打开时由管理服务使用服务端 Token 登录 localhost 上游，转发认证 Cookie 并重定向到 `/zellij/<session>`，Token 不出现在浏览器 URL、HTML 或响应正文中。
9. Zellij Web 只监听 localhost；入口 HTML 的 base 被改写为 `/zellij/`，登录 HTTP 和终端 WebSocket 均通过主服务代理。
10. Zellij `0.44.3` 已知静态资源返回一天的私有 immutable 缓存、版本化弱 ETag 和 gzip；匹配 `If-None-Match` 时直接返回 `304` 且不请求上游。HTML、登录/API 和 WebSocket 不使用该静态缓存策略。
11. 桌面和移动浏览器的 Zellij 入口都显示圆形浮动快捷键盘；首次打开时默认贴边收起，隐藏球体主体并仅保留半透明可点击圆弧，不占用整行或缩短终端高度，交互时恢复完整按钮，之后收起并闲置 3 秒再次自动贴边；浮球贴边后点击页面其他区域不得将其唤醒。拖动结束吸附到最近侧边并保存贴边方向与垂直位置比例，切换横竖屏、视口尺寸或移动浏览器桌面版模式后仍保持贴边。展开时仅有 `Ctrl+P N` 和 `Ctrl+P X` 两个圆形按钮沿浮动按钮上方呈环状展开。两个按钮必须按顺序写入两段固定序列，并在发送后自动收起快捷键盘、同步恢复折叠状态，例如 `Ctrl+P N` 写入 `0x10` 后写入 ASCII `n`；桌面和触摸操作都不得主动聚焦终端或其他可编辑输入，拖动按钮不得触发页面平移，并按动画帧合并位置更新。
12. 防火墙只需公开主服务端口，Zellij Web、code-viewer 和 OpenVSCode 端口从外部不可访问。
13. Session 表格默认隐藏；Workspace 管理区的“会话列表”按钮打开弹窗，弹窗可通过关闭按钮、遮罩和 Esc 关闭，并在打开或成功删除 Session 后自动关闭。

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

当前首版仓库页面覆盖：点击“Code Reviewer”会先同步打开同源启动页，启动页再通过 API 启动或复用 localhost:8022 的 code-viewer，并把自身导航到同源 viewer 地址；该流程不依赖移动浏览器向原页面返回新标签页窗口句柄，切换仓库会停止旧实例。repository 没有对应 Session 时显示创建按钮，已有时显示安全打开链接和删除按钮。“Code Reviewer”旁边显示“VS Code”链接，安全地在新标签页打开后端为该 repository 生成的同源 HTTPS OpenVSCode URL；URL 的 `folder` 参数必须等于重新执行真实路径和对应来源边界校验后的 repository 目录，前端不得自行拼接路径。`/openvscode` 必须保留基路径代理普通 HTTP 和 WebSocket 流量，上游只监听 localhost。

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
23. viewer 启动失败时启动页显示可理解的错误，不停留在空白页面。
24. 轮询不覆盖 starting 和 stopping 状态。

## 当前扩展：Codex Web 对话

1. repository 条目的“与 Codex 对话”链接使用新标签页、`noopener noreferrer` 和编码后的 repository ID。
2. 可用性检查固定执行 `codex --version`，使用参数数组、`shell: false`、5 秒超时和 64 KiB 输出上限。
3. CLI 可用时状态接口返回脱敏版本并启用输入；不存在、不可执行、超时或退出失败时返回 unavailable，页面显示操作提示并禁用发送。
4. 消息接口在启动后台 turn 前再次检查 CLI；不可用时返回 `503 CODEX_CLI_UNAVAILABLE` 且不调用 Codex turn。
5. `/codex-chat` 只接受列表中仍然存在的 repository ID；用户消息和头像靠右，Codex 回复和头像靠左。“新对话”、repository 路径和返回入口默认隐藏在抽屉中，可通过菜单按钮打开，并可通过关闭按钮、遮罩和 Esc 关闭；桌面和移动布局均能完成发送、停止和新对话操作。
6. “Add file”只列出当前 repository 内普通文件的 opaque ID、相对路径和大小；`.git`、依赖/构建目录、符号链接和超过 128 KiB 的文件不显示。
7. 前端最多选择 8 个文件，显示可移除附件标签，并只提交 server-issued file ID；发送后的用户消息显示本次附件路径。
8. 每个文件在读取前重新执行 `realpath()` 和 repository containment 校验；伪造、跨 repository、失效或变成越界符号链接的 ID 被拒绝。
9. 二进制、非严格 UTF-8、单文件超过 128 KiB、总计超过 512 KiB 和重复文件 ID 被拒绝，错误不包含文件绝对路径或内容。
10. 请求只允许 `repositoryId`、可选 UUID `conversationId`、可选 `contextFileIds` 和 1 到 20000 字符的 `message`；路径、命令、参数、环境变量和额外字段被拒绝。
11. 每次发送前通过 RepositoryService 重新执行 repository 真实路径和对应来源边界校验。
12. 首次消息固定启动 `codex app-server --listen stdio://`，完成 `initialize`/`initialized` 后调用 `thread/start` 和 `turn/start`；包含校验后文件 JSON 的 prompt 只通过 JSON-RPC 文本输入发送，且 `shell: false`。
13. 后续消息使用 app-server `thread/resume` 恢复 conversation ID，再调用 `turn/start`；审批策略、repository cwd 和 workspace-write 可写根目录全部由服务端固定。
14. 只有 Codex 返回的合法 UUID 会被登记；进程内已知 conversation 只能由原 repository 继续，服务重启后浏览器保存的合法 UUID 使用 Codex 原生 resume 恢复。
15. 同一 repository 不允许同时运行两个 turn，新对话不复用旧 conversation ID。
16. 消息接口返回 `202` 和后台对话快照；快照查询返回消息、conversation ID、状态、脱敏错误和更新时间。
17. 后端不返回 Codex 原始 JSONL、stderr、工具事件、usage、异常堆栈或原始失败详情。
18. 助手文本中的当前 repository 绝对路径被替换为相对根标记 `.`。
19. 浏览器关闭、刷新或连接断开不终止 Codex；显式停止会终止整个进程组，5 秒后仍未退出时升级为 `SIGKILL`。
20. 30 分钟超时和 4 MiB stdout 超限会清理进程组并返回脱敏错误，stderr 保留量不超过 64 KiB且不返回浏览器。
21. 管理服务关闭会取消所有活动 Codex turn，且不删除任何 Zellij Session。
22. 再次进入同一 repository 时恢复服务端快照；运行中通过同源 SSE 接收 app-server `item/agentMessage/delta` 对应的脱敏快照，密集 delta 在不超过 40 毫秒的窗口内合并发送且最终状态立即发送，断线重连后恢复完整助手文本；浏览器对运行中快照的持久化不超过每 100 毫秒一次，最终状态立即保存；首段文本到达前显示等待动画，部分文本到达后最新助手消息持续显示动态生成提示，完成后提示消失；停留底部时自动跟随流式输出，向上阅读历史时保持当前滚动位置并提供回到最新消息入口。
23. Codex 页面通过 `pagehide` 和组件卸载释放 EventSource；服务端在 SSE 响应关闭、错误或请求中止时释放订阅和心跳，且这些断线路径都不停止后台 turn。管理首页读取 `/api/codex/activity`，在窗口重新获得焦点或定时刷新时把对应 repository 的 Codex 按钮显示为“生成中”。失败或停止且没有助手文本时不显示等待动画。
23. 管理服务重启后，本地 `running` 快照转换为已中断状态，保留消息和 conversation ID，下一条消息使用原生 resume。
24. “新对话”在无运行中 turn 时清空服务端和浏览器快照；运行中请求返回冲突。
25. Codex turn 成功完成后才持久化 repository ID 到 conversation ID；运行中、失败、停止和超时不写入新 ID。
26. 管理服务重启、换浏览器或换设备后，从状态文件恢复 conversation ID，并通过 app-server `thread/read`（`includeTurns: true`）恢复脱敏的历史用户/助手消息；页面无需依赖原浏览器缓存即可显示完整历史，下一条消息固定使用 app-server `thread/resume` 恢复该 ID。thread 历史读取失败、thread ID 与 repository cwd 不匹配或历史超限时返回脱敏错误，不得静默创建新 conversation。
27. `codexChatAppearance` 只接受非空字体族和 `12` 到 `24` 的整数像素字号；`GET /api/codex/appearance` 只返回这两个字段，页面把配置应用到消息、输入和抽屉文本。任意 Codex 页面抽屉中的字体和字号覆盖立即生效、保存到浏览器并跨 repository 共享，恢复默认后删除覆盖并重新应用服务端配置。
28. “Add file”按照 repository 相对路径构建可展开目录树，目录优先于文件；路径搜索只显示匹配文件及其父目录并自动展开，文件选择仍提交原服务端签发的 opaque ID。

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
