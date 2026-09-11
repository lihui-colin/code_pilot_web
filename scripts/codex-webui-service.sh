#!/usr/bin/env bash
#
# Codex WebUI 源码构建与服务管理脚本
#
# 默认部署 https://github.com/LimLLL/codex-webui 到本项目的同级目录，
# 复用当前用户已经可用的 Codex CLI、认证和配置。
#
# 用法:
#   ./scripts/codex-webui-service.sh deploy   # 首次克隆（如需）、构建并启动；默认动作
#   ./scripts/codex-webui-service.sh update   # 拉取上游更新、构建并重启
#   ./scripts/codex-webui-service.sh build    # 安装依赖并构建前后端
#   ./scripts/codex-webui-service.sh start    # 后台启动
#   ./scripts/codex-webui-service.sh stop     # 停止服务及其子进程
#   ./scripts/codex-webui-service.sh restart  # 重启但不重新构建
#   ./scripts/codex-webui-service.sh status   # 查看进程及端口状态
#   ./scripts/codex-webui-service.sh logs     # 跟随日志
#
# 可配置环境变量:
#   CODEX_WEBUI_DIR              源码/部署目录，默认 ../codex-webui
#   CODEX_WEBUI_REPO             Git 仓库地址
#   CODEX_WEBUI_REF              首次克隆的分支或 tag，默认 main
#   CODEX_WEBUI_PORT             监听端口，默认 8023
#   CODEX_WEBUI_WORKSPACE_ROOTS  WebUI 可访问的工作区根目录
#   CODEX_WEBUI_CODEX_BIN        Codex CLI 绝对路径，默认取 command -v codex
#   CODEX_WEBUI_CODEX_HOME       Codex 配置目录，默认 ~/.codex
#   CODEX_WEBUI_AUTH_DISABLED    首次配置是否免密，默认 true（仅限可信网络）
#   WEBUI_API_KEY                首次生成 .env 时使用；未提供则自动生成
#
# deploy 不自动拉取或覆盖已有源码；使用 update 显式拉取安全的 fast-forward 更新。

set -euo pipefail

script_file="$(readlink -f "${BASH_SOURCE[0]}")"
project_root="$(cd "$(dirname "$script_file")/.." && pwd)"
projects_root="$(dirname "$project_root")"

deploy_dir="$(readlink -m "${CODEX_WEBUI_DIR:-$projects_root/codex-webui}")"
repository_url="${CODEX_WEBUI_REPO:-https://github.com/LimLLL/codex-webui.git}"
repository_ref="${CODEX_WEBUI_REF:-main}"
service_port="${CODEX_WEBUI_PORT:-8023}"
workspace_roots="${CODEX_WEBUI_WORKSPACE_ROOTS:-$projects_root}"
codex_home_dir="${CODEX_WEBUI_CODEX_HOME:-$HOME/.codex}"
auth_disabled="${CODEX_WEBUI_AUTH_DISABLED:-true}"
codex_bin="${CODEX_WEBUI_CODEX_BIN:-$(command -v codex 2>/dev/null || true)}"
node_bin="$(command -v node 2>/dev/null || true)"
pnpm_bin="$(command -v pnpm 2>/dev/null || true)"

env_file="$deploy_dir/.env"
runtime_dir="$deploy_dir/.service"
pid_file="$runtime_dir/codex-webui.pid"
log_file="$runtime_dir/codex-webui.log"

log()  { printf '\033[1;34m[codex-webui]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[codex-webui]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[codex-webui]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
    sed -n '2,/^$/s/^# \{0,1\}//p' "$script_file"
}

version_ge() {
    [[ "$(printf '%s\n' "$1" "$2" | sort -V | tail -n 1)" == "$1" ]]
}

validate_settings() {
    [[ "$service_port" =~ ^[0-9]+$ ]] || fail "端口必须是数字: $service_port"
    (( 10#$service_port >= 1 && 10#$service_port <= 65535 )) \
        || fail "端口超出有效范围: $service_port"
    [[ "$workspace_roots" != *$'\n'* ]] || fail "工作区根目录不能包含换行符"
    [[ "$codex_home_dir" != *$'\n'* ]] || fail "Codex 配置目录不能包含换行符"
    [[ "$auth_disabled" == "true" || "$auth_disabled" == "false" ]] \
        || fail "CODEX_WEBUI_AUTH_DISABLED 必须是 true 或 false"
}

require_build_tools() {
    command -v git >/dev/null 2>&1 || fail "未找到 git"
    [[ -n "$node_bin" && -x "$node_bin" ]] || fail "未找到 node"
    [[ -n "$pnpm_bin" && -x "$pnpm_bin" ]] || fail "未找到 pnpm"
    local node_version
    node_version="$($node_bin --version | sed 's/^v//')"
    version_ge "$node_version" "20.0.0" \
        || fail "Node.js 版本过低（当前 $node_version，需要 >= 20）"
}

require_runtime_tools() {
    [[ -n "$node_bin" && -x "$node_bin" ]] || fail "未找到 node"
    [[ -n "$codex_bin" && -x "$codex_bin" ]] || fail "未找到可执行的 Codex CLI"
    command -v setsid >/dev/null 2>&1 || fail "未找到 setsid（通常由 util-linux 提供）"
    command -v curl >/dev/null 2>&1 || fail "未找到 curl"
}

ensure_source() {
    if [[ -d "$deploy_dir/.git" ]]; then
        log "使用已有源码: $deploy_dir"
        return
    fi
    [[ ! -e "$deploy_dir" ]] \
        || fail "部署目录已存在但不是 Git 仓库: $deploy_dir"
    mkdir -p "$(dirname "$deploy_dir")"
    log "克隆 $repository_url（$repository_ref）到 $deploy_dir"
    git clone --branch "$repository_ref" --single-branch -- "$repository_url" "$deploy_dir"
}

update_source() {
    require_build_tools
    ensure_source

    if ! git -C "$deploy_dir" diff --quiet \
        || ! git -C "$deploy_dir" diff --cached --quiet \
        || [[ -n "$(git -C "$deploy_dir" ls-files --others --exclude-standard)" ]]; then
        warn "检测到本地修改；更新会保留它们，若与上游冲突则安全中止"
    fi

    log "获取上游更新: origin/$repository_ref"
    git -C "$deploy_dir" fetch --prune origin "$repository_ref"

    if ! git -C "$deploy_dir" merge-base --is-ancestor HEAD FETCH_HEAD; then
        fail "上游历史无法 fast-forward 到当前版本；未修改源码，请手动处理分支历史"
    fi

    if [[ "$(git -C "$deploy_dir" rev-parse HEAD)" == \
          "$(git -C "$deploy_dir" rev-parse FETCH_HEAD)" ]]; then
        log "源码已经是最新版本"
        return
    fi

    if ! git -C "$deploy_dir" merge --ff-only FETCH_HEAD; then
        fail "上游更新与本地修改冲突；未覆盖本地文件，请手动处理后重试"
    fi
    log "源码已更新到 $(git -C "$deploy_dir" rev-parse --short HEAD)"
}

random_secret() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32
    else
        "$node_bin" -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
    fi
}

has_api_key() {
    [[ -n "${WEBUI_API_KEY:-}" ]] && return 0
    [[ -f "$env_file" ]] || return 1
    awk -F= '
        /^[[:space:]]*WEBUI_API_KEY[[:space:]]*=/ {
            value = substr($0, index($0, "=") + 1)
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
            if (value != "" && value != "change-me-to-a-random-secret") found = 1
        }
        END { exit(found ? 0 : 1) }
    ' "$env_file"
}

ensure_environment() {
    mkdir -p "$deploy_dir/data" "$deploy_dir/logs" "$runtime_dir"
    if [[ ! -f "$env_file" ]]; then
        local api_key
        api_key="${WEBUI_API_KEY:-$(random_secret)}"
        umask 077
        {
            printf 'NODE_ENV=production\n'
            printf 'PORT=%s\n' "$service_port"
            printf 'WEBUI_API_KEY=%s\n' "$api_key"
            printf 'WEBUI_AUTH_DISABLED=%s\n' "$auth_disabled"
            printf 'OPENAI_API_KEY=\n'
            printf 'CODEX_BIN=%s\n' "$codex_bin"
            printf 'CODEX_HOME=%s\n' "$codex_home_dir"
            printf 'WEBUI_DB_PATH=%s\n' "$deploy_dir/data/codex-webui.sqlite"
            printf 'WORKSPACE_ROOTS=%s\n' "$workspace_roots"
            printf 'LOG_LEVEL=info\n'
        } > "$env_file"
        chmod 600 "$env_file"
        log "已创建配置: $env_file（API Key 未输出到终端）"
    elif ! has_api_key; then
        fail "$env_file 缺少有效的 WEBUI_API_KEY，请设置后重试"
    else
        chmod 600 "$env_file"
        log "保留已有配置: $env_file"
    fi
}

build_service() {
    require_build_tools
    ensure_source
    ensure_environment
    log "安装后端依赖"
    (cd "$deploy_dir" && "$pnpm_bin" install --frozen-lockfile)
    log "安装并构建前端"
    (cd "$deploy_dir" && "$pnpm_bin" --dir web install --frozen-lockfile)
    (cd "$deploy_dir" && "$pnpm_bin" --dir web build)
    log "构建后端"
    (cd "$deploy_dir" && "$pnpm_bin" build)
    [[ -f "$deploy_dir/dist/main.js" ]] || fail "后端构建产物缺失: dist/main.js"
    [[ -f "$deploy_dir/public/index.html" ]] || fail "前端构建产物缺失: public/index.html"
    log "构建完成"
}

read_pid() {
    [[ -f "$pid_file" ]] || return 1
    local pid
    pid="$(tr -d '[:space:]' < "$pid_file")"
    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    printf '%s' "$pid"
}

is_managed_process() {
    local pid="$1" process_cwd process_command
    kill -0 "$pid" 2>/dev/null || return 1
    process_cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    [[ "$process_cwd" == "$deploy_dir" ]] || return 1
    process_command="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    [[ "$process_command" == *"dist/main.js"* ]]
}

port_is_open() {
    curl --silent --output /dev/null --max-time 1 \
        "http://127.0.0.1:$service_port/" 2>/dev/null
}

start_service() {
    validate_settings
    require_runtime_tools
    [[ -f "$deploy_dir/dist/main.js" ]] || fail "尚未构建，请先执行 build 或 deploy"
    ensure_environment

    local pid
    if pid="$(read_pid)" && is_managed_process "$pid"; then
        log "服务已在运行（PID $pid）: http://0.0.0.0:$service_port"
        return
    fi
    rm -f "$pid_file"
    if port_is_open; then
        fail "端口 $service_port 已被其他服务占用"
    fi

    log "启动服务: http://0.0.0.0:$service_port"
    (
        cd "$deploy_dir"
        umask 077
        nohup setsid env \
            NODE_ENV=production \
            PORT="$service_port" \
            CODEX_BIN="$codex_bin" \
            CODEX_HOME="$codex_home_dir" \
            WEBUI_DB_PATH="$deploy_dir/data/codex-webui.sqlite" \
            WORKSPACE_ROOTS="$workspace_roots" \
            "$node_bin" dist/main.js </dev/null >>"$log_file" 2>&1 &
        printf '%s\n' "$!" > "$pid_file"
        chmod 600 "$pid_file"
    )

    pid="$(read_pid)" || fail "服务未写入有效 PID"
    local attempt
    for ((attempt = 1; attempt <= 60; attempt++)); do
        if ! is_managed_process "$pid"; then
            warn "服务启动后提前退出，最近日志如下："
            tail -n 50 "$log_file" >&2 || true
            rm -f "$pid_file"
            exit 1
        fi
        if port_is_open; then
            log "服务已就绪（PID $pid）: http://0.0.0.0:$service_port"
            log "日志: $log_file"
            return
        fi
        sleep 0.5
    done
    fail "服务在 30 秒内未监听端口 $service_port，请查看 $log_file"
}

stop_service() {
    local pid
    if ! pid="$(read_pid)"; then
        log "服务未运行"
        return
    fi
    if ! is_managed_process "$pid"; then
        warn "PID 文件不是本脚本启动的有效进程，已清理: $pid_file"
        rm -f "$pid_file"
        return
    fi

    local process_group
    process_group="$(ps -o pgid= -p "$pid" | tr -d '[:space:]')"
    log "停止服务（PID $pid）"
    if [[ "$process_group" == "$pid" ]]; then
        kill -TERM -- "-$process_group" 2>/dev/null || true
    else
        kill -TERM "$pid" 2>/dev/null || true
    fi

    local attempt
    for ((attempt = 1; attempt <= 40; attempt++)); do
        if ! kill -0 "$pid" 2>/dev/null; then
            rm -f "$pid_file"
            log "服务已停止"
            return
        fi
        sleep 0.25
    done

    warn "服务未在 10 秒内退出，发送 SIGKILL"
    if [[ "$process_group" == "$pid" ]]; then
        kill -KILL -- "-$process_group" 2>/dev/null || true
    else
        kill -KILL "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
}

show_status() {
    local pid
    if pid="$(read_pid)" && is_managed_process "$pid"; then
        printf 'Codex WebUI 运行中（PID %s） -> http://0.0.0.0:%s\n' "$pid" "$service_port"
        if port_is_open; then
            printf 'HTTP 探测: OK\n'
            return 0
        fi
        printf 'HTTP 探测: 尚未就绪\n'
        return 1
    fi
    printf 'Codex WebUI 未运行\n'
    return 1
}

follow_logs() {
    [[ -f "$log_file" ]] || fail "日志文件不存在: $log_file"
    tail -n 100 -f "$log_file"
}

action="${1:-deploy}"
[[ $# -le 1 ]] || fail "只接受一个动作参数；使用 --help 查看用法"
validate_settings

case "$action" in
    deploy)
        build_service
        stop_service
        start_service
    ;;
    update)
        update_source
        build_service
        stop_service
        start_service
    ;;
    build)
        build_service
    ;;
    start)
        start_service
    ;;
    stop)
        stop_service
    ;;
    restart)
        stop_service
        start_service
    ;;
    status)
        show_status
    ;;
    logs)
        follow_logs
    ;;
    -h|--help|help)
        usage
    ;;
    *)
        fail "未知动作: $action（支持 deploy|update|build|start|stop|restart|status|logs）"
    ;;
esac
