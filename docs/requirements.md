# 产品需求

## 目标

通过浏览器管理服务器上的 Zellij Session，并在 Session 中使用 Codex CLI；同时浏览启动参数指定的工作目录，并为识别出的源代码目录启动或复用 code-viewer。

系统仅在公司内网开放，用户通过 VPN 访问，不设置应用用户名和密码。

## 总体架构

```text
Browser
|
| VPN / company intranet / HTTP
v
Management Web Application
|-- Session API ------> zellij CLI ------> Zellij Sessions
|                                           |
|                                           v
|                                      Zellij Web
|
|-- Repository API ---> configured workspace root
|
|-- Codex Chat API ---> codex app-server in validated repository
|
`-- Viewer API -------> localhost code-viewer processes
                         ^
                         `-- HTTP/WebSocket proxy
```

浏览器不能直接执行 Zellij、启动进程或遍历服务器目录。管理服务负责参数校验、目录边界校验、外部进程调用、状态管理和访问地址生成。

## Zellij Session 体验

Workspace 管理区提供“会话列表”按钮，点击后以默认隐藏的弹出窗口展示 Session。弹窗至少展示：

- Session 名称。
- 创建时间，未知时显示为空。
- 工作目录，未知时显示为空。
- managed 或 external 来源。
- 运行状态。
- 打开和删除操作。

每个 Git repository 固定对应一个由服务端命名的 Session。用户不需要输入 Session 名称：没有对应 Session 时可以创建 Codex Session，已有对应 Session 时可以直接打开 Zellij Web，也可以删除该 Session。

创建成功后立即刷新列表，但不自动打开 Session。用户点击“打开”时，在新的浏览器标签页中访问后端返回的 Zellij Web HTTPS 地址；管理页面不内嵌 Zellij Web，也不在打开操作中创建或修改 Session。会话弹窗支持关闭按钮、遮罩和 Esc 关闭；打开会话或成功删除会话后自动关闭。

删除 Session 会终止其中运行的 Codex 和其他进程，因此必须展示完整 Session 名称，并要求用户再次输入准确名称确认。

管理服务退出或重启时不得删除 Zellij Session。

主页提供统一“重启后台服务”操作。重启会断开当前 Zellij Web、code-viewer 和 OpenVSCode 浏览器连接，必须二次确认；后台应清理本项目管理的相关进程、进程组、PID 状态和配置端口后重新拉起服务，但不得按名称误杀其他项目实例或删除 Zellij Session。

## 工作目录体验

管理服务启动时必须传入工作目录：

```bash
npm start -- --workspace-root /home/lihui/projects
```

也可以使用编译后的入口：

```bash
node dist/server.js --workspace-root /home/lihui/projects
```

未传参数、目录不存在或目录不可读时，服务启动失败，不回退到当前目录、用户主目录或服务器根目录。

主页只展示 Git repository，workspace 自动发现结果保持扁平列表：

- workspace 自身包含 `.git` 文件或目录时，只展示 workspace 本身，不探测子目录。
- workspace 自身不是 Git repository 时，递归探测其可见子目录并展示任意深度的 Git repository。
- 找到 Git repository 后不再进入该 repository 内部，普通容器目录继续递归。
- 所有结果以扁平列表展示，相对路径用于区分不同层级或同名 repository。
- `package.json`、`pyproject.toml`、`Cargo.toml`、`go.mod` 和 `pom.xml` 只用于补充已识别 Git repository 的技术栈标识，不能单独使目录进入列表。

页面同时提供类似 VSCode “Open Folder”的“添加文件夹”操作。用户可以从服务器文件系统根目录逐层进入服务进程可读的目录；目录选择器只交换后端签发的不透明目录 ID，不允许浏览器提交绝对路径。只有当前包含 `.git` 文件或目录的目录可以选择。选中的 workspace 外 Git repository 持久化到状态文件，服务重启后继续显示，并可从列表移除；移除不会删除服务器文件或 Zellij Session。

列表条目至少展示名称、显示路径、workspace/手动来源、Git repository 类型、识别依据和 viewer 状态。所有后续操作仍只使用服务端 repository ID。

## code-viewer 体验

每个源代码目录最多对应一个 code-viewer 实例。

用户点击“浏览”时：

1. 当前点击事件先打开空白标签页，避免异步启动导致弹窗被拦截。
2. 前端调用 Viewer API。
3. 后端复用健康实例或启动新实例。
4. 成功后把空白标签页导航到后端返回的同源代理地址。
5. 失败时关闭空白标签页，并在管理页面显示可理解的错误。

启动过程中显示稳定的 `starting` 状态并禁止重复提交。用户可以停止不再需要的 viewer。viewer 进程异常退出、启动超时或长时间空闲时，服务清理实例和端口记录。

管理页面不内嵌 code-viewer，不向用户暴露 localhost 上游端口或服务器绝对路径。

## Codex 对话体验

每个 Git repository 条目提供“与 Codex 对话”链接，在新标签页打开独立的 `/codex-chat` 页面。页面加载时先检查后台服务能否调用 Codex CLI；可用时展示版本并启用输入，不可用时禁用发送并提示检查安装、可执行权限和后台服务用户的 `PATH`。用户发送的消息和头像靠右显示，Codex 回复和头像靠左显示；用户显示名默认为 `me`，可以在抽屉面板中修改并保存在当前浏览器。任意 Codex 页面都可以在抽屉的字体下拉列表中选择常用字体，并修改 `12` 到 `24` 像素的字号；偏好在当前浏览器的所有 Codex 页面间共享，并可以恢复为服务器配置的默认值。“新对话”、repository 路径、返回首页和运行信息放在默认隐藏的抽屉面板中，通过顶部菜单按钮打开，并支持遮罩和 Esc 关闭；主对话区域始终占满可用宽度。消息输入框提供“Add file”，从服务端列出的当前 repository 普通文本文件中最多选择 8 个作为本次消息的限定上下文；已选文件以可移除标签展示，发送后也显示在用户消息中。页面展示后台响应状态和停止操作；等待首段回复时显示等待动画，收到部分助手文本但 turn 尚未结束时在最新回复下持续显示动态“正在继续生成”提示，完成后自动隐藏。用户停留在消息底部时流式内容自动跟随；向上滚动阅读历史后不得被新片段强制拉回，并提供回到最新消息的快捷入口。关闭或刷新页面时未完成的 Codex turn 继续在管理服务后台运行，再次进入同一 repository 时恢复消息、conversation ID 和运行状态。管理服务重启后使用浏览器安全快照恢复历史，并通过 Codex 原生 resume 继续会话。支持 Enter 发送、Shift+Enter 换行，并适配桌面和移动浏览器。

消息输入框默认显示一行文字高度，内容变长或通过 Shift+Enter 换行时随内容自动增高，达到最大高度后在输入框内部滚动。“Add file”弹窗按照 repository 相对路径显示可展开和折叠的目录树，目录优先于文件排列；搜索只保留匹配文件及其父目录并自动展开结果。用户只提交 repository ID、自然语言消息和服务端签发的上下文文件 ID。服务端重新解析 repository 和每个文件的真实路径并执行对应来源的路径边界校验，然后在该 repository 中通过 Codex app-server 运行 turn，固定跳过审批并使用仅允许当前 repository 写入的 workspace-write 沙箱，因此该入口只适用于受信任的 VPN 用户。用户不能从浏览器提交目录、绝对路径、文件路径、可执行文件、命令参数、环境变量或 Codex 配置。

首条消息创建由 Codex 返回的 conversation ID；后续消息使用 Codex 原生 resume 继续 conversation。新对话会清空页面和服务端快照并重新创建 conversation。页面关闭不得清理 Codex 进程组；只有用户点击停止、管理服务关闭、30 分钟超时或输出超过限制时，后端才清理该次 Codex 进程组。

Codex 对话快照只包含 conversation ID、用户与助手文本、运行状态和脱敏错误，不展示原始工具事件、标准错误、服务器绝对路径、附件内容或异常堆栈。

## 管理页面

第一屏直接展示可操作界面：

- 管理服务状态。
- Zellij Web 状态。
- Workspace 和 Git repository 列表，以及其中的“会话列表”弹窗入口。
- viewer 状态和操作。

每个 Git repository 只常驻显示两个主要操作：已有 Session 时显示“打开 Zellij Web”，否则显示“创建 Zellij Session”；另一个为“与 Codex 对话”。编辑代码、code-viewer、删除 Session 和移除手动仓库收纳在“更多操作”菜单中，危险操作与普通操作视觉分隔。

只读数据默认每 10 秒刷新。页面不可见时暂停轮询，重新可见时立即刷新。创建、删除和停止操作完成后立即重新查询对应资源。

部分工具未就绪时，页面仍允许从 Workspace 区域打开能够读取的 Zellij Session 列表和 Zellij Web Token 管理侧边栏；未就绪状态只阻止依赖缺失工具的操作。

桌面和移动浏览器均不能出现文字溢出、控件重叠或依赖 hover 才能完成的核心操作。

## 错误体验

页面错误需要包含可理解的操作结果，但不能泄露：

- 服务器绝对路径。
- 除主页默认隐藏的 Token 管理侧边栏之外的 Zellij Token。
- 环境变量。
- 原始外部命令输出。
- 未经处理的异常堆栈。

浏览器阻止新标签页时，应提示用户允许该站点打开弹窗。

## 安全边界

- 页面、API、Zellij Web、viewer、OpenVSCode 和 Codex Chat 使用主服务端口的同源 HTTPS，并由 VPN 和防火墙限制访问网段。
- Zellij Web 保留自身 Token 验证；管理服务首次启动创建专用 Token，同时保存名称和值，并在主页默认隐藏的侧边栏中提供复制、删除和重新创建操作。侧边栏通过明确的 Token 管理按钮打开，可通过关闭按钮、遮罩和 Esc 关闭。
- Token 成功写入浏览器剪贴板后，主页显示“已复制”反馈。
- 自动扫描只允许访问启动时配置的工作目录；workspace 外目录只能通过服务器目录选择器主动加入。
- 每次目录相关操作都重新执行真实路径和对应来源边界校验。
- 禁止前端提交任意命令、命令参数、环境变量、KDL 或绝对路径。
- 管理服务和 code-viewer 使用普通用户运行，不使用 root。
- Zellij 缺失时由项目安装固定版本；HTTPS 证书在管理服务首次启动时初始化，由公开管理入口和 localhost Zellij Web 上游共同使用，浏览器只访问管理入口。
- 项目启动时确保默认 Zellij 配置包含 `web_sharing "on"`，使之后通过 `zellij --session` 创建的 Session 也能从浏览器打开；已运行的旧 Session 不自动删除或重建。

每个 Git repository 条目提供以下操作：

- 尚无对应 Session 时显示“创建 Zellij Session”，在该 repository 的真实目录创建 Codex Session。
- 已有对应 Session 时显示“打开 Zellij Web”和“删除 Session”；打开仓库绑定的 Session 时自动复制当前 Zellij Web Token，并显示复制结果；服务重启后仍通过固定名称识别对应关系。
- “code-viewer”：打开空白标签页，启动或复用该 repository 的 code-viewer，成功后导航到管理服务同源 viewer 地址。
- “编辑代码”：在“code-viewer”旁边以新标签页打开后端为该 repository 生成的同源 HTTPS OpenVSCode 地址，并通过 `folder` 参数自动打开该 repository。OpenVSCode 由部署侧使用配置的 workspace root 启动，只监听默认端口 `127.0.0.1:8023`，由管理服务代理 `/openvscode` HTTP 和 WebSocket 流量；后端重新校验 repository 真实路径和对应来源边界，前端不提交或拼接目录、绝对路径、命令或环境变量。
- “与 Codex 对话”：在新标签页打开该 repository 的独立流式对话页面；服务端校验 repository ID 并固定 Codex app-server 的进程参数、工作目录、审批与沙箱策略，前端只提交自然语言消息和服务端签发的 conversation ID。
- 手动 repository 显示“移除仓库”；该操作只删除状态记录，不删除文件、Session 或进程。
- code-viewer 只监听 localhost，上游端口不对 VPN 网络开放。
- 写请求执行同源校验。
- 记录 Session 创建、删除和 viewer 启停审计日志。
- 主机防火墙只允许 VPN 网段访问管理入口；Zellij Web、OpenVSCode 与 code-viewer 上游端口不得公开。

## 与现有脚本的关系

- `run_zellij.sh` 继续用于本地验证，正式部署由 systemd 守护 Zellij Web。
- `start-code-viewer-proxy.sh` 只用于单实例探测，其进程和代理逻辑迁移到常驻管理服务。
- `run_ttyd.sh` 和 `run_code_server.sh` 不属于 Terminal Web 正式运行链路。

精确 API、路径、进程和状态行为见 [实施契约](contracts.md)。
