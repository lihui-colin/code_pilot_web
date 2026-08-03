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
`-- Viewer API -------> localhost code-viewer processes
                         ^
                         `-- HTTP/WebSocket proxy
```

浏览器不能直接执行 Zellij、启动进程或遍历服务器目录。管理服务负责参数校验、目录边界校验、外部进程调用、状态管理和访问地址生成。

## Zellij Session 体验

Session 列表至少展示：

- Session 名称。
- 创建时间，未知时显示为空。
- 工作目录，未知时显示为空。
- managed 或 external 来源。
- 运行状态。
- 打开和删除操作。

每个 Git repository 固定对应一个由服务端命名的 Session。用户不需要输入 Session 名称：没有对应 Session 时可以创建 Codex Session，已有对应 Session 时可以直接打开 Zellij Web，也可以删除该 Session。

创建成功后立即刷新列表，但不自动打开 Session。用户点击“打开”时，在新的浏览器标签页中访问后端返回的 Zellij Web HTTPS 地址；管理页面不内嵌 Zellij Web，也不在打开操作中创建或修改 Session。

删除 Session 会终止其中运行的 Codex 和其他进程，因此必须展示完整 Session 名称，并要求用户再次输入准确名称确认。

管理服务退出或重启时不得删除 Zellij Session。

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

页面只展示 Git repository，不提供目录导航：

- workspace 自身包含 `.git` 文件或目录时，只展示 workspace 本身，不探测子目录。
- workspace 自身不是 Git repository 时，递归探测其可见子目录并展示任意深度的 Git repository。
- 找到 Git repository 后不再进入该 repository 内部，普通容器目录继续递归。
- 所有结果以扁平列表展示，相对路径用于区分不同层级或同名 repository。
- `package.json`、`pyproject.toml`、`Cargo.toml`、`go.mod` 和 `pom.xml` 只用于补充已识别 Git repository 的技术栈标识，不能单独使目录进入列表。

列表条目至少展示名称、相对路径、Git repository 类型、识别依据和 viewer 状态。前端只使用服务端目录 ID，不提交绝对路径。

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

## 管理页面

第一屏直接展示可操作界面：

- 管理服务状态。
- Zellij Web 状态。
- Session 表格。
- workspace 和 Git repository 列表。
- viewer 状态和操作。

只读数据默认每 10 秒刷新。页面不可见时暂停轮询，重新可见时立即刷新。创建、删除和停止操作完成后立即重新查询对应资源。

部分工具未就绪时，页面仍展示能够读取的 Zellij Session 和 Zellij Web Token；未就绪状态只阻止依赖缺失工具的操作。

桌面和移动浏览器均不能出现文字溢出、控件重叠或依赖 hover 才能完成的核心操作。

## 错误体验

页面错误需要包含可理解的操作结果，但不能泄露：

- 服务器绝对路径。
- 除主页专用 Token 展示区之外的 Zellij Token。
- 环境变量。
- 原始外部命令输出。
- 未经处理的异常堆栈。

浏览器阻止新标签页时，应提示用户允许该站点打开弹窗。

## 安全边界

- 页面、API 和 viewer 代理无需应用登录或 TLS，使用同源 HTTP，并由 VPN 和防火墙限制访问网段。
- Zellij Web 保留自身 Token 验证；管理服务首次启动创建专用 Token，同时保存名称和值并在主页提供复制、删除和重新创建操作。
- Token 成功写入浏览器剪贴板后，主页显示“已复制”反馈。
- 只允许访问启动时配置的工作目录。
- 每次目录相关操作都重新执行真实路径边界校验。
- 禁止前端提交任意命令、命令参数、环境变量、KDL 或绝对路径。
- 管理服务和 code-viewer 使用普通用户运行，不使用 root。
- Zellij 缺失时由项目安装固定版本；Zellij Web 的 HTTPS 证书在管理服务首次启动时初始化并由 Zellij Web 独立使用。
- 项目启动时确保默认 Zellij 配置包含 `web_sharing "on"`，使之后通过 `zellij --session` 创建的 Session 也能从浏览器打开；已运行的旧 Session 不自动删除或重建。

每个 Git repository 条目提供以下操作：

- 尚无对应 Session 时显示“创建 Zellij Session”，在该 repository 的真实目录创建 Codex Session。
- 已有对应 Session 时显示“打开 Zellij Web”和“删除 Session”；打开仓库绑定的 Session 时自动复制当前 Zellij Web Token，并显示复制结果；服务重启后仍通过固定名称识别对应关系。
- “打开 code-viewer”：打开空白标签页，启动或复用该 repository 的 code-viewer，成功后导航到管理服务同源 viewer 地址。
- code-viewer 只监听 localhost，上游端口不对 VPN 网络开放。
- 写请求执行同源校验。
- 记录 Session 创建、删除和 viewer 启停审计日志。
- 主机防火墙只允许 VPN 网段访问公开入口和 Zellij Web。

## 与现有脚本的关系

- `run_zellij.sh` 继续用于本地验证，正式部署由 systemd 守护 Zellij Web。
- `start-code-viewer-proxy.sh` 只用于单实例探测，其进程和代理逻辑迁移到常驻管理服务。
- `run_ttyd.sh` 和 `run_code_server.sh` 不属于 Terminal Web 正式运行链路。

精确 API、路径、进程和状态行为见 [实施契约](contracts.md)。
