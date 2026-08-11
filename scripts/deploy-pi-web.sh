#!/usr/bin/env bash
#
# pi-web (agegr) 一键部署脚本
#
# 在一台新机器上完成 pi-web + pi agent 的完整部署：
#   1. 安装 Node.js (>= 22.19) —— 若缺失则通过 nvm 安装
#   2. 安装/升级 pi agent (~/.pi)
#   3. 全局安装 @agegr/pi-web
#   4. 复用运行管理脚本 scripts/pi-web-run.sh（若缺失则提示）
#   5. 部署自检（doctor）并可选启动服务
#
# 用法:
#   ./scripts/deploy-pi-web.sh              # 部署并自检
#   ./scripts/deploy-pi-web.sh --no-run     # 只部署，不启动服务
#   PI_WEB_HOST=0.0.0.0 PI_WEB_PORT=8024 ./scripts/deploy-pi-web.sh
#
# 可配置环境变量:
#   PI_WEB_HOST          绑定地址，默认 0.0.0.0
#   PI_WEB_PORT          监听端口，默认 8024
#   PI_WEB_PASSWORD      设置后开启 Basic Auth（用户名固定为 pi）
#   NODE_MAJOR           通过 nvm 安装的 Node 主版本，默认 22
#
# 说明：pi-web 需与 pi 运行在同一 OS/容器，会读取 ~/.pi/agent/sessions。

set -euo pipefail

# ---------- 可配置项 ----------
PI_WEB_HOST="${PI_WEB_HOST:-0.0.0.0}"
PI_WEB_PORT="${PI_WEB_PORT:-8024}"
PI_WEB_PASSWORD="${PI_WEB_PASSWORD:-}"
NODE_MAJOR="${NODE_MAJOR:-22}"

# ---------- 路径 ----------
script_file="$(readlink -f "${BASH_SOURCE[0]}")"
project_root="$(cd "$(dirname "$script_file")/.." && pwd)"
run_script="$project_root/scripts/pi-web-run.sh"

log()  { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; }

# ---------- 版本比较：ver1 >= ver2 ----------
ver_ge() { [[ "$(printf '%s\n' "$1" "$2" | sort -V | tail -n1)" == "$1" ]]; }

# ---------- 步骤 1：Node.js ----------
ensure_node() {
    if command -v node >/dev/null 2>&1; then
        local ver
        ver="$(node --version | sed 's/^v//')"
        if ver_ge "$ver" "22.19.0"; then
            log "Node.js v$ver 满足要求 (>= 22.19.0)"
            return 0
        fi
        warn "Node.js 版本过低（v$ver），将通过 nvm 安装 Node $NODE_MAJOR"
    else
        log "未检测到 Node.js，将通过 nvm 安装"
    fi
    
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
        log "安装 nvm..."
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    fi
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
    log "安装 Node $NODE_MAJOR ..."
    nvm install "$NODE_MAJOR"
    nvm use "$NODE_MAJOR"
    nvm alias default "$NODE_MAJOR"
    command -v node >/dev/null 2>&1 || { err "Node 安装后仍不可用，请手动安装 Node.js >= 22.19"; exit 1; }
}

# ---------- 步骤 2：pi agent ----------
ensure_pi() {
    if command -v pi >/dev/null 2>&1; then
        log "pi agent 已安装: $(pi --version 2>/dev/null || echo '版本未知')"
        return 0
    fi
    log "未检测到 pi agent，开始安装 pi..."
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL https://pi.dev/install.sh | bash || {
            warn "pi 官方安装脚本执行失败，请手动安装：https://github.com/badlogic/pi-mono"
        }
    else
        warn "未找到 curl，请手动安装 pi agent：https://github.com/badlogic/pi-mono"
    fi
    command -v pi >/dev/null 2>&1 || warn "pi 已安装但未进入 PATH，请重新登录 shell 或检查 PATH"
}

# ---------- 步骤 3：@agegr/pi-web ----------
install_pi_web() {
    # 若存在命令名冲突的旧包 @jmfederico/pi-web，先卸载（两者 bin 都叫 pi-web）
    if npm ls -g --depth=0 "@jmfederico/pi-web" >/dev/null 2>&1; then
        warn "检测到冲突的旧包 @jmfederico/pi-web，正在卸载..."
        npm uninstall -g @jmfederico/pi-web
    fi
    log "全局安装 @agegr/pi-web ..."
    npm install -g "@agegr/pi-web@latest"
    command -v pi-web >/dev/null 2>&1 && log "pi-web 已安装: $(pi-web --version 2>/dev/null || echo '')" \
    || warn "pi-web 已安装但全局命令未进入 PATH"
}

# ---------- 步骤 4：复用运行脚本 ----------
ensure_run_script() {
    if [[ -x "$run_script" ]]; then
        log "运行脚本已就绪: $run_script"
    else
        warn "未找到可执行运行脚本 $run_script，请先创建它（参考 scripts/pi-web-run.sh）"
    fi
}

# ---------- 步骤 5：自检 ----------
doctor() {
    log "===== pi-web 部署自检 ====="
    local ok=1
    if command -v node >/dev/null 2>&1; then
        local ver; ver="$(node --version | sed 's/^v//')"
        if ver_ge "$ver" "22.19.0"; then
            log "  [OK] Node.js v$ver"
        else
            err "  [X] Node.js v$ver 版本过低"
            ok=0
        fi
    else
        err "  [X] Node.js 缺失"; ok=0
    fi
    
    if command -v pi >/dev/null 2>&1; then
        log "  [OK] pi agent $(pi --version 2>/dev/null || echo '')"
    else
        err "  [X] pi agent 缺失"; ok=0
    fi
    
    if command -v pi-web >/dev/null 2>&1; then
        log "  [OK] pi-web $(pi-web --version 2>/dev/null || echo '')"
    else
        err "  [X] pi-web 缺失"; ok=0
    fi
    
    if command -v curl >/dev/null 2>&1; then
        log "  [OK] curl"
    else
        warn "  [warn] curl 缺失（影响启动就绪探测）"
    fi
    
    if [[ -d "$HOME/.pi/agent/sessions" ]]; then
        log "  [OK] pi 会话目录 $HOME/.pi/agent/sessions"
    else
        warn "  [warn] 尚无 pi 会话目录（首次使用 pi 后生成）"
    fi
    
    log "  目标: http://$PI_WEB_HOST:$PI_WEB_PORT"
    if [[ -n "$PI_WEB_PASSWORD" ]]; then
        log "  [OK] 已启用 Basic Auth（用户名 pi）"
    else
        warn "  [warn] 未启用认证，仅限可信网络使用"
    fi
    
    if [[ $ok -eq 0 ]]; then
        err "自检未通过，请修复上述 [X] 项"
        return 1
    fi
    log "自检通过 ✔"
}

# ---------- 入口 ----------
RUN_AFTER=1
for arg in "$@"; do
    case "$arg" in
        --no-run) RUN_AFTER=0 ;;
        -h|--help) grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) warn "未知参数忽略: $arg" ;;
    esac
done

log "开始 pi-web 部署 (host=$PI_WEB_HOST port=$PI_WEB_PORT)"
ensure_node
ensure_pi
install_pi_web
ensure_run_script
doctor

if [[ $RUN_AFTER -eq 1 ]] && [[ -x "$run_script" ]]; then
    log "启动 pi-web 服务..."
    "$run_script" start
fi
log "部署完成"
