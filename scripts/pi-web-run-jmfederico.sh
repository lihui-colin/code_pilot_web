#!/usr/bin/env bash
#
# PI WEB (jmfederico) 手动运行管理脚本
#
# 适用于无 systemd user 总线（容器 / WSL / 精简服务器）的环境，按官方
# “manual run” 方式分别启动 session daemon 和 web/API 服务。
#
# 用法:
#   ./scripts/pi-web-run-jmfederico.sh start                # 后台启动（sessiond + server）
#   ./scripts/pi-web-run-jmfederico.sh start --port 8080    # 指定端口启动
#   ./scripts/pi-web-run-jmfederico.sh stop                 # 停止
#   ./scripts/pi-web-run-jmfederico.sh restart [--port N]   # 按指定端口重启
#   ./scripts/pi-web-run-jmfederico.sh update [更新选项]    # 升级 pi 和 pi-web
#   ./scripts/pi-web-run-jmfederico.sh status               # 查看状态
#   ./scripts/pi-web-run-jmfederico.sh logs                 # 跟随服务日志
#
# 可配置参数:
#   --port <port>    监听端口（优先级高于 PI_WEB_PORT 环境变量，默认 8024）
#
# 可配置环境变量:
#   PI_WEB_HOST      绑定地址，默认 0.0.0.0
#   PI_WEB_PORT      监听端口，默认 8024
#   PI_WEB_PASSWORD  设置后（若支持）开启访问保护

set -euo pipefail

PI_WEB_HOST="${PI_WEB_HOST:-0.0.0.0}"
PI_WEB_PORT="${PI_WEB_PORT:-8024}"
PI_WEB_PASSWORD="${PI_WEB_PASSWORD:-}"

usage() {
    cat <<'EOF'
PI WEB (jmfederico) 手动运行管理脚本

用法:
  ./scripts/pi-web-run-jmfederico.sh start                # 后台启动（sessiond + server）
  ./scripts/pi-web-run-jmfederico.sh start --port 8080    # 指定端口启动
  ./scripts/pi-web-run-jmfederico.sh stop                 # 停止
  ./scripts/pi-web-run-jmfederico.sh restart [--port N]   # 按指定端口重启
  ./scripts/pi-web-run-jmfederico.sh update [更新选项]    # 升级 pi 和 pi-web
  ./scripts/pi-web-run-jmfederico.sh status [--port N]    # 查看状态
  ./scripts/pi-web-run-jmfederico.sh logs                 # 跟随服务日志
  ./scripts/pi-web-run-jmfederico.sh --help               # 显示本帮助

参数:
  --port <port>    监听端口（优先级高于 PI_WEB_PORT 环境变量，默认 8024）
  -h, --help       显示本帮助并退出

更新选项:
  --pi-only        只升级 Pi Coding Agent
  --web-only       只升级 @jmfederico/pi-web
  --no-restart     升级后不重启服务
  --restart        即使服务原先未运行，升级后也启动
  --update-relay   同步升级全局 relay skill
  --dry-run        只显示将执行的升级操作

环境变量:
  PI_WEB_HOST      绑定地址，默认 0.0.0.0
  PI_WEB_PORT      监听端口，默认 8024
  PI_WEB_PASSWORD  设置后（若支持）开启访问保护
  PI_VERSION       update 使用的 pi 目标版本，默认 latest
  PI_WEB_VERSION   update 使用的 pi-web 目标版本，默认 latest
EOF
}

# ---------- 参数解析 ----------
ACTION=""
ACTION_ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            usage
            exit 0
        ;;
        --port)
            [[ $# -ge 2 ]] || { echo "错误：--port 需要端口号参数" >&2; exit 2; }
            PI_WEB_PORT="$2"
            shift 2
        ;;
        --port=*)
            PI_WEB_PORT="${1#*=}"
            shift
        ;;
        start|stop|restart|update|status|logs)
            ACTION="$1"
            shift
        ;;
        *)
            ACTION_ARGS+=("$1")
            shift
        ;;
    esac
done
[[ -n "$ACTION" ]] || ACTION="${ACTION_ARGS[0]:-run}"

script_file="$(readlink -f "${BASH_SOURCE[0]}")"
project_root="$(cd "$(dirname "$script_file")/.." && pwd)"
log_dir="$project_root/data/pi-web"
server_log="$log_dir/server.log"
sessiond_log="$log_dir/sessiond.log"
server_pid="$log_dir/server.pid"
sessiond_pid="$log_dir/sessiond.pid"
update_script="$project_root/scripts/update-pi-web-jmfederico.sh"

require_bins() {
    command -v pi-web-server   >/dev/null 2>&1 || { echo "错误：未找到 pi-web-server" >&2; exit 1; }
    command -v pi-web-sessiond >/dev/null 2>&1 || { echo "错误：未找到 pi-web-sessiond" >&2; exit 1; }
}

check_port_free() {
    if command -v ss >/dev/null 2>&1; then
        if ss -tlnp 2>/dev/null | grep -q ":$PI_WEB_PORT "; then
            echo "错误：端口 $PI_WEB_PORT 已被占用" >&2
            exit 1
        fi
    fi
}

start() {
    require_bins
    mkdir -p "$log_dir"
    
    # 会话守护进程
    if [[ ! -f "$sessiond_pid" ]] || ! kill -0 "$(cat "$sessiond_pid")" 2>/dev/null; then
        echo "启动 pi-web-sessiond ..."
        nohup pi-web-sessiond >"$sessiond_log" 2>&1 &
        echo $! > "$sessiond_pid"
    else
        echo "pi-web-sessiond 已在运行 (PID $(cat "$sessiond_pid"))"
    fi
    
    # Web/API 服务
    if [[ ! -f "$server_pid" ]] || ! kill -0 "$(cat "$server_pid")" 2>/dev/null; then
        check_port_free
        echo "启动 pi-web-server -> http://$PI_WEB_HOST:$PI_WEB_PORT"
        if [[ -n "$PI_WEB_PASSWORD" ]]; then
            PI_WEB_PASSWORD="$PI_WEB_PASSWORD" PI_WEB_PORT="$PI_WEB_PORT" PI_WEB_HOST="$PI_WEB_HOST" \
            nohup pi-web-server >"$server_log" 2>&1 &
        else
            PI_WEB_PORT="$PI_WEB_PORT" PI_WEB_HOST="$PI_WEB_HOST" \
            nohup pi-web-server >"$server_log" 2>&1 &
        fi
        echo $! > "$server_pid"
    else
        echo "pi-web-server 已在运行 (PID $(cat "$server_pid"))"
    fi
    
    # 等服务就绪（最多约 15 秒）
    for _ in $(seq 1 30); do
        if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PI_WEB_PORT/" 2>/dev/null; then
            break
        fi
        sleep 0.5
    done
    status
}

stop_pid() {
    local name="$1" pidfile="$2"
    if [[ -f "$pidfile" ]]; then
        local pid; pid="$(cat "$pidfile")"
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            sleep 1
            kill -9 "$pid" 2>/dev/null || true
            echo "已停止 $name (PID $pid)"
        fi
        rm -f "$pidfile"
    fi
}

stop() {
    stop_pid "pi-web-server"   "$server_pid"
    stop_pid "pi-web-sessiond" "$sessiond_pid"
}

status() {
    local any=0
    if [[ -f "$server_pid" ]] && kill -0 "$(cat "$server_pid")" 2>/dev/null; then
        echo "pi-web-server   运行中 (PID $(cat "$server_pid")) -> http://$PI_WEB_HOST:$PI_WEB_PORT"
        curl -s -o /dev/null -w "   HTTP 状态: %{http_code}\n" "http://127.0.0.1:$PI_WEB_PORT/" 2>/dev/null || echo "   探测失败"
        any=1
    else
        echo "pi-web-server   未在运行"
    fi
    if [[ -f "$sessiond_pid" ]] && kill -0 "$(cat "$sessiond_pid")" 2>/dev/null; then
        echo "pi-web-sessiond 运行中 (PID $(cat "$sessiond_pid"))"
        any=1
    else
        echo "pi-web-sessiond 未在运行"
    fi
    [[ $any -eq 1 ]]
}

logs() {
    local f="$server_log"
    [[ -f "$f" ]] || f="$sessiond_log"
    tail -f -n 50 "$f"
}

update() {
    if [[ ! -x "$update_script" ]]; then
        echo "错误：未找到可执行升级脚本 $update_script" >&2
        exit 1
    fi
    PI_WEB_HOST="$PI_WEB_HOST" PI_WEB_PORT="$PI_WEB_PORT" PI_WEB_PASSWORD="$PI_WEB_PASSWORD" \
        "$update_script" "${ACTION_ARGS[@]}"
}

case "$ACTION" in
    start)   start ;;
    stop)    stop ;;
    restart) stop; start ;;
    update)  update ;;
    status)  status ;;
    logs)    logs ;;
    *)
        echo "用法: $0 {start|stop|restart|update|status|logs} [--port <port>]" >&2
        exit 2
    ;;
esac
