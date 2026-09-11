#!/usr/bin/env bash
#
# 更新 jmfederico/pi-web 与 Pi Coding Agent（@earendil-works/pi-coding-agent）
#
# 本机当前部署是全局 npm 包 + 无 systemd 的 manual run（sessiond + server）。
# 升级会替换全局包；若服务正在运行，默认先停再装，装完再拉起。
#
# 用法:
#   ./scripts/update-pi-web-jmfederico.sh                 # 更新 pi + pi-web，必要时重启
#   ./scripts/update-pi-web-jmfederico.sh --pi-only       # 只更新 pi agent
#   ./scripts/update-pi-web-jmfederico.sh --web-only      # 只更新 @jmfederico/pi-web
#   ./scripts/update-pi-web-jmfederico.sh --no-restart    # 更新后不重启服务
#   ./scripts/update-pi-web-jmfederico.sh --restart       # 即使原先未运行也启动
#   ./scripts/update-pi-web-jmfederico.sh --update-relay  # 同步更新全局 relay skill
#   ./scripts/update-pi-web-jmfederico.sh --dry-run       # 只打印将要执行的操作
#   PI_VERSION=0.85.1 PI_WEB_VERSION=1.202609.0 ./scripts/update-pi-web-jmfederico.sh
#
# 环境变量:
#   PI_VERSION       pi agent 目标版本，默认 latest
#   PI_WEB_VERSION   @jmfederico/pi-web 目标版本，默认 latest
#   PI_WEB_HOST / PI_WEB_PORT / PI_WEB_PASSWORD  传给运行脚本（重启时）

set -euo pipefail

script_file="$(readlink -f "${BASH_SOURCE[0]}")"
project_root="$(cd "$(dirname "$script_file")/.." && pwd)"
run_script="$project_root/scripts/pi-web-run-jmfederico.sh"
pid_dir="$project_root/data/pi-web"

PI_PKG="@earendil-works/pi-coding-agent"
WEB_PKG="@jmfederico/pi-web"
PI_VERSION="${PI_VERSION:-latest}"
PI_WEB_VERSION="${PI_WEB_VERSION:-latest}"

UPDATE_PI=1
UPDATE_WEB=1
UPDATE_RELAY=0
DO_RESTART="auto"   # auto | always | never
DRY_RUN=0

log()  { printf '\033[1;34m[update-jmf]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[update-jmf]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m[update-jmf]\033[0m %s\n' "$*" >&2; }

ver_ge() { [[ "$(printf '%s\n' "$1" "$2" | sort -V | tail -n1)" == "$1" ]]; }

usage() {
    awk 'NR==1 { next } /^#($| )/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
}

run() {
    if [[ $DRY_RUN -eq 1 ]]; then
        log "[dry-run] $*"
        return 0
    fi
    "$@"
}

pkg_version() {
    local pkg="$1"
    npm ls -g --depth=0 --json "$pkg" 2>/dev/null \
    | node -e '
            let s = "";
            process.stdin.on("data", d => s += d);
            process.stdin.on("end", () => {
              try {
                const j = JSON.parse(s || "{}");
                const deps = j.dependencies || {};
                const name = process.argv[1];
                process.stdout.write((deps[name] && deps[name].version) || "");
              } catch {
                process.stdout.write("");
              }
            });
    ' "$pkg"
}

cli_version() {
    local bin="$1"
    if ! command -v "$bin" >/dev/null 2>&1; then
        echo ""
        return 0
    fi
    case "$bin" in
        pi) pi --version 2>/dev/null | head -n1 | tr -d '[:space:]' ;;
        pi-web)
            pi-web version 2>/dev/null | awk '
                /@jmfederico\/pi-web:/ { print $NF; found=1 }
                END { if (!found) print "" }
            '
        ;;
        *) echo "" ;;
    esac
}

service_running() {
    local pidfile
    for pidfile in "$pid_dir/server.pid" "$pid_dir/sessiond.pid"; do
        if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile" 2>/dev/null)" 2>/dev/null; then
            return 0
        fi
    done
    return 1
}

# ---------- 参数 ----------
for arg in "$@"; do
    case "$arg" in
        --pi-only)       UPDATE_WEB=0 ;;
        --web-only)      UPDATE_PI=0 ;;
        --update-relay)  UPDATE_RELAY=1 ;;
        --no-restart)    DO_RESTART="never" ;;
        --restart)       DO_RESTART="always" ;;
        --dry-run)       DRY_RUN=1 ;;
        -h|--help)       usage; exit 0 ;;
        *)
            err "未知参数: $arg"
            usage >&2
            exit 2
        ;;
    esac
done

if [[ $UPDATE_PI -eq 0 && $UPDATE_WEB -eq 0 ]]; then
    err "--pi-only 与 --web-only 不能同时使用"
    exit 2
fi

# ---------- 前置检查 ----------
check_node() {
    command -v node >/dev/null 2>&1 || { err "未找到 node，需要 Node.js >= 22.19.0"; exit 1; }
    command -v npm >/dev/null 2>&1 || { err "未找到 npm"; exit 1; }
    local ver; ver="$(node --version | sed 's/^v//')"
    if ! ver_ge "$ver" "22.19.0"; then
        err "Node.js 版本过低（v$ver），需要 >= 22.19.0"
        exit 1
    fi
    log "Node.js v$ver"
}

check_conflict() {
    if npm ls -g --depth=0 "@agegr/pi-web" >/dev/null 2>&1; then
        err "检测到全局 @agegr/pi-web，与 @jmfederico/pi-web 命令名冲突，不能共存。"
        err "请先卸载: npm uninstall -g @agegr/pi-web"
        exit 1
    fi
}

stop_services() {
    if [[ ! -x "$run_script" ]]; then
        warn "未找到可执行运行脚本 $run_script，跳过停止"
        return 0
    fi
    log "停止 pi-web（sessiond + server）..."
    run "$run_script" stop || warn "停止脚本返回非零，继续升级"
}

start_services() {
    if [[ ! -x "$run_script" ]]; then
        err "未找到可执行运行脚本 $run_script，无法启动"
        return 1
    fi
    log "启动 pi-web（sessiond + server）..."
    run "$run_script" start
}

update_pi() {
    local before after
    before="$(pkg_version "$PI_PKG")"
    [[ -n "$before" ]] || before="$(cli_version pi)"
    [[ -n "$before" ]] || before="(未安装)"
    log "更新 $PI_PKG@$PI_VERSION （当前 $before）..."
    run npm install -g --ignore-scripts "${PI_PKG}@${PI_VERSION}"
    hash -r 2>/dev/null || true
    after="$(pkg_version "$PI_PKG")"
    [[ -n "$after" ]] || after="$(cli_version pi)"
    log "pi agent: $before -> ${after:-未知}"
}

update_web() {
    local before after
    before="$(pkg_version "$WEB_PKG")"
    [[ -n "$before" ]] || before="$(cli_version pi-web)"
    [[ -n "$before" ]] || before="(未安装)"
    log "更新 $WEB_PKG@$PI_WEB_VERSION （当前 $before）..."
    run npm install -g "${WEB_PKG}@${PI_WEB_VERSION}" --allow-scripts=node-pty
    hash -r 2>/dev/null || true
    after="$(pkg_version "$WEB_PKG")"
    [[ -n "$after" ]] || after="$(cli_version pi-web)"
    log "pi-web: $before -> ${after:-未知}"
}

update_relay() {
    log "更新全局 relay skill（npx skills add jmfederico/pi-web --skill relay -a pi -g）..."
    run npx --yes skills add jmfederico/pi-web --skill relay -a pi -g
}

doctor() {
    log "===== 更新后状态 ====="
    if command -v pi >/dev/null 2>&1; then
        local pv; pv="$(pi --version 2>/dev/null || echo 未知)"
        if ver_ge "$pv" "0.84.0"; then
            log "  [OK] pi $pv"
        else
            warn "  [warn] pi $pv 低于 pi-web 要求的 >= 0.84.0"
        fi
    else
        err "  [X] pi 命令不可用"
    fi
    
    if command -v pi-web >/dev/null 2>&1; then
        log "  [OK] pi-web $(cli_version pi-web || echo '')"
        if [[ $DRY_RUN -eq 0 ]]; then
            pi-web version || true
        fi
    else
        err "  [X] pi-web 命令不可用"
    fi
    
    if [[ -x "$run_script" && $DRY_RUN -eq 0 ]]; then
        "$run_script" status || true
    fi
}

# ---------- 主流程 ----------
log "开始更新 jmfederico/pi-web 与 pi agent"
[[ $DRY_RUN -eq 1 ]] && log "dry-run 模式：不会真正安装或重启"
check_node
check_conflict

was_running=0
if service_running; then
    was_running=1
    log "检测到 pi-web 正在运行"
fi

need_stop=0
if [[ $UPDATE_WEB -eq 1 || $UPDATE_PI -eq 1 ]]; then
    if [[ $was_running -eq 1 && "$DO_RESTART" != "never" ]]; then
        need_stop=1
    fi
fi

if [[ $need_stop -eq 1 ]]; then
    stop_services
fi

if [[ $UPDATE_PI -eq 1 ]]; then
    update_pi
fi
if [[ $UPDATE_WEB -eq 1 ]]; then
    update_web
fi
if [[ $UPDATE_RELAY -eq 1 ]]; then
    update_relay
fi

should_start=0
if [[ "$DO_RESTART" == "always" ]]; then
    should_start=1
    elif [[ "$DO_RESTART" == "auto" && $was_running -eq 1 ]]; then
    should_start=1
fi

if [[ $should_start -eq 1 ]]; then
    start_services
    elif [[ $was_running -eq 1 && "$DO_RESTART" == "never" ]]; then
    warn "服务已停止且指定 --no-restart，请稍后执行: $run_script start"
fi

doctor
log "更新完成"
log "管理命令: $run_script {start|stop|restart|update|status|logs}"
