#!/usr/bin/env bash
#
# pi-web (agegr) 启动/管理脚本
#
# 用法:
#   ./scripts/pi-web-run.sh start            # 后台启动
#   ./scripts/pi-web-run.sh stop             # 停止
#   ./scripts/pi-web-run.sh restart          # 重启
#   ./scripts/pi-web-run.sh status           # 查看状态
#   ./scripts/pi-web-run.sh run              # 前台运行（默认）
#   ./scripts/pi-web-run.sh logs             # 跟随日志
#
# 可通过环境变量覆盖默认值:
#   PI_WEB_HOST  绑定地址，默认 0.0.0.0
#   PI_WEB_PORT  监听端口，默认 8024
#   PI_WEB_PASSWORD  设置后开启 Basic Auth（用户名固定为 pi）

set -euo pipefail

# ---------- 可配置项 ----------
PI_WEB_HOST="${PI_WEB_HOST:-0.0.0.0}"
PI_WEB_PORT="${PI_WEB_PORT:-8024}"
PI_WEB_PASSWORD="${PI_WEB_PASSWORD:-}"

# ---------- 路径 ----------
script_file="$(readlink -f "${BASH_SOURCE[0]}")"
project_root="$(cd "$(dirname "$script_file")/.." && pwd)"
log_file="$project_root/data/pi-web.log"
pid_file="$project_root/data/pi-web.pid"

# ---------- 依赖检查 ----------
require_node() {
    command -v node >/dev/null 2>&1 || { echo "错误：未找到 node，请先安装 Node.js >= 22.19" >&2; exit 1; }
    local ver
    ver="$(node --version | sed 's/^v//')"
    if [[ "$(printf '%s\n' "$ver" "22.19.0" | sort -V | head -n1)" != "22.19.0" ]]; then
        echo "错误：Node.js 版本过低（当前 $ver），需要 >= 22.19.0" >&2
        exit 1
    fi
}

check_port_free() {
    if command -v ss >/dev/null 2>&1; then
        if ss -tlnp 2>/dev/null | grep -q ":${PI_WEB_PORT} "; then
            echo "错误：端口 $PI_WEB_PORT 已被占用" >&2
            exit 1
        fi
        elif command -v lsof >/dev/null 2>&1; then
        if lsof -iTCP:"$PI_WEB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
            echo "错误：端口 $PI_WEB_PORT 已被占用" >&2
            exit 1
        fi
    fi
}

# ---------- 启动/停止 ----------
start() {
    require_node
    if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
        echo "pi-web 已在运行 (PID $(cat "$pid_file"))"
        return 0
    fi
    check_port_free
    
    mkdir -p "$(dirname "$log_file")"
    local cmd_args=(npx -y @agegr/pi-web@latest --port "$PI_WEB_PORT" --hostname "$PI_WEB_HOST" --no-open)
    
    echo "启动 pi-web -> http://$PI_WEB_HOST:$PI_WEB_PORT"
    echo "日志: $log_file"
    
    if [[ -n "$PI_WEB_PASSWORD" ]]; then
        PI_WEB_PASSWORD="$PI_WEB_PASSWORD" PI_WEB_NO_OPEN=1 nohup "${cmd_args[@]}" >"$log_file" 2>&1 &
    else
        PI_WEB_NO_OPEN=1 nohup "${cmd_args[@]}" >"$log_file" 2>&1 &
    fi
    echo $! > "$pid_file"
    
    # 轮询等待服务就绪（最多约 15 秒）
    for _ in $(seq 1 30); do
        if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PI_WEB_PORT/" 2>/dev/null; then
            break
        fi
        sleep 0.5
    done
    status
}

# 递归收集 pid 的所有后代进程 PID
descendants() {
    local pid="$1" child out=""
    for child in $(pgrep -P "$pid" 2>/dev/null); do
        out="$out $child $(descendants "$child")"
    done
    echo "$out"
}

kill_tree() {
    local pid="$1" all
    all="$pid $(descendants "$pid")"
    # 从最深的子进程开始杀，避免二次派生
    for p in $(echo "$all" | tr ' ' '\n' | tac); do
        [[ -n "$p" ]] && kill "$p" 2>/dev/null || true
    done
    # 等待退出
    sleep 1
    for p in $(echo "$all" | tr ' ' '\n' | tac); do
        [[ -n "$p" ]] && kill -9 "$p" 2>/dev/null || true
    done
}

stop() {
    if [[ ! -f "$pid_file" ]]; then
        echo "pi-web 未在运行"
        return 0
    fi
    local pid
    pid="$(cat "$pid_file")"
    if kill -0 "$pid" 2>/dev/null; then
        kill_tree "$pid"
        echo "已停止 pi-web (PID $pid)"
    else
        echo "pi-web 未在运行（残留 pid 文件已清理）"
    fi
    rm -f "$pid_file"
}

status() {
    if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
        echo "pi-web 正在运行 (PID $(cat "$pid_file")) -> http://$PI_WEB_HOST:$PI_WEB_PORT"
        if command -v curl >/dev/null 2>&1; then
            curl -s -o /dev/null -w "  HTTP 状态: %{http_code}\n" "http://127.0.0.1:$PI_WEB_PORT/" 2>/dev/null \
            || echo "  警告：本地探测失败"
        fi
    else
        echo "pi-web 未在运行"
        return 1
    fi
}

logs() {
    if [[ -f "$log_file" ]]; then
        tail -f "$log_file"
    else
        echo "日志文件不存在: $log_file" >&2
        exit 1
    fi
}

# ---------- 入口 ----------
action="${1:-run}"
case "$action" in
    start)   start ;;
    stop)    stop ;;
    restart) stop; start ;;
    status)  status ;;
    logs)    logs ;;
    run)
        require_node
        check_port_free
        echo "前台运行 pi-web -> http://$PI_WEB_HOST:$PI_WEB_PORT (Ctrl+C 退出)"
        if [[ -n "$PI_WEB_PASSWORD" ]]; then
            PI_WEB_PASSWORD="$PI_WEB_PASSWORD" PI_WEB_NO_OPEN=1 npx -y @agegr/pi-web@latest \
            --port "$PI_WEB_PORT" --hostname "$PI_WEB_HOST" --no-open
        else
            PI_WEB_NO_OPEN=1 npx -y @agegr/pi-web@latest \
            --port "$PI_WEB_PORT" --hostname "$PI_WEB_HOST" --no-open
        fi
    ;;
    *)
        echo "用法: $0 {start|stop|restart|status|logs|run}" >&2
        exit 2
    ;;
esac
