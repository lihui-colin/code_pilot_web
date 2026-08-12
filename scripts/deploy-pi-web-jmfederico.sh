#!/usr/bin/env bash
#
# PI WEB (jmfederico) 一键部署脚本
#
# 部署 https://github.com/jmfederico/pi-web —— Pi Coding Agent 的持久化
# Web UI（会话在真实工作区中持续运行）。
#
# 说明：此包与 @agegr/pi-web 的全局命令都叫 `pi-web`，二者不能共存。
#   默认脚本只做检测并给出指引；加 --replace-agegr 才会自动卸载 agegr 版。
#
# 用法:
#   ./scripts/deploy-pi-web-jmfederico.sh               # 部署并自检
#   ./scripts/deploy-pi-web-jmfederico.sh --replace-agegr # 自动替换冲突的 agegr 版
#   ./scripts/deploy-pi-web-jmfederico.sh --no-install   # 仅自检，不安装
#   ./scripts/deploy-pi-web-jmfederico.sh --help         # 帮助
#
# 步骤:
#   1. Node.js 检查 (>= 22.19.0)
#   2. 检测并处理 bin 冲突（agegr / jmfederico）
#   3. 全局安装 @jmfederico/pi-web（--allow-scripts=node-pty）
#   4. pi-web install 注册按用户服务；若无 systemd user 总线（如 docker 内）
#      则自动降级为手动运行（scripts/pi-web-run.sh 分别管理 sessiond + server
#      两个进程，默认端口 8024）
#   5. pi-web doctor 自检 + 展示状态
#
# 提示:
#   - 默认端口 8024，配置位于 ~/.config/pi-web/config.json（$PI_WEB_CONFIG 可覆盖）
#   - 需 Node.js >= 22.19、npm、Pi Coding Agent >= 0.84.0
#   - 勿直接暴露到公网，请走 VPN / SSH 隧道 / 可信反向代理

set -euo pipefail

# ---------- 可配置 ----------
CONFLICT_ACTION="detect"   # detect | replace-agegr

# ---------- 路径 ----------
script_file="$(readlink -f "${BASH_SOURCE[0]}")"
project_root="$(cd "$(dirname "$script_file")/.." && pwd)"

log()  { printf '\033[1;34m[deploy-jmf]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy-jmf]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m[deploy-jmf]\033[0m %s\n' "$*" >&2; }

ver_ge() { [[ "$(printf '%s\n' "$1" "$2" | sort -V | tail -n1)" == "$1" ]]; }

# ---------- 解析参数 ----------
DO_INSTALL=1
for arg in "$@"; do
    case "$arg" in
        --replace-agegr) CONFLICT_ACTION="replace-agegr" ;;
        --no-install)    DO_INSTALL=0 ;;
        -h|--help)       grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) warn "未知参数忽略: $arg" ;;
    esac
done

# ---------- 步骤 1：Node.js ----------
check_node() {
    command -v node >/dev/null 2>&1 || { err "未找到 node，请安装 Node.js >= 22.19.0"; return 1; }
    local ver; ver="$(node --version | sed 's/^v//')"
    if ver_ge "$ver" "22.19.0"; then
        log "Node.js v$ver 满足要求 (>= 22.19.0)"
        return 0
    fi
    err "Node.js 版本过低（v$ver），jmfederico/pi-web 需要 >= 22.19.0"
    return 1
}

# ---------- 步骤 2：检测 bin 冲突 ----------
detect_conflict() {
    if ! command -v pi-web >/dev/null 2>&1; then
        log "未检测到全局 pi-web，可直接安装"
        return 0
    fi
    # 判断当前 pi-web 属于哪个包
    if npm ls -g --depth=0 "@jmfederico/pi-web" >/dev/null 2>&1; then
        log "已安装 jmfederico/pi-web（可执行 upgrade）"
        return 0
    fi
    if npm ls -g --depth=0 "@agegr/pi-web" >/dev/null 2>&1; then
        warn "检测到全局 pi-web 属于 @agegr/pi-web（与 jmfederico 版命令名冲突，不能共存）"
        if [[ "$CONFLICT_ACTION" == "replace-agegr" ]]; then
            log "按 --replace-agegr 自动卸载 @agegr/pi-web ..."
            npm uninstall -g @agegr/pi-web
        else
            err "请先卸载 @agegr/pi-web（npm uninstall -g @agegr/pi-web），"
            err "或在脚本后加 --replace-agegr 让脚本自动卸载。"
            err "如需保留 agegr 版，请勿在本机部署 jmfederico 版。"
            return 1
        fi
    else
        warn "检测到未知来源的全局 pi-web，无法确认归属。"
        warn "若其与 jmfederico 版冲突，请手动卸载后重试；或加 --replace-agegr。"
    fi
    return 0
}

# ---------- 步骤 3：安装 ----------
install_pi_web() {
    if [[ $DO_INSTALL -eq 0 ]]; then
        log "跳过安装（--no-install）"
        return 0
    fi
    log "安装 @jmfederico/pi-web（--allow-scripts=node-pty）..."
    # node-pty 需编译原生模块；--allow-scripts=node-pty 只放行该依赖的安装脚本
    npm install -g @jmfederico/pi-web --allow-scripts=node-pty
    log "完成全局安装"
}

# ---------- 步骤 4：注册服务 ----------
install_service() {
    if [[ $DO_INSTALL -eq 0 ]]; then
        log "跳过服务注册（--no-install）"
        return 0
    fi
    command -v pi-web >/dev/null 2>&1 || { err "pi-web 命令不可用，无法注册服务"; return 1; }
    log "执行 pi-web install（注册按用户服务）..."
    if pi-web install; then
        log "pi-web 服务注册成功"
        return 0
    else
        log "pi-web install 失败（通常因本机无 systemd user 总线），将改用手动运行脚本"
        return 2
    fi
}

# ---------- 步骤 4b：无 systemd 环境 fallback ----------
setup_manual_run() {
    local run_script="$project_root/scripts/pi-web-run.sh"
    if [[ ! -x "$run_script" ]]; then
        err "缺少手动运行脚本 $run_script，请创建后重试"
        return 1
    fi
    warn "当前环境无可用 systemd user 服务管理器，采用官方 manual run 方式："
    warn "  会话进程: pi-web-sessiond"
    warn "  Web/API : pi-web-server -> http://127.0.0.1:8024"
    warn "管理脚本: $run_script  （start|stop|restart|status|logs）"
    # 若已通过 npm 全局安装 pi-web，这里可直接提示启动
    if command -v pi-web-server >/dev/null 2>&1; then
        log "服务已安装（pi-web-server / pi-web-sessiond 可用），可随时执行："
        log "  $run_script start"
    fi
    return 0
}

# ---------- 步骤 5：自检 ----------
doctor() {
    log "===== PI WEB (jmfederico) 自检 ====="
    command -v pi-web >/dev/null 2>&1 \
    && log "  [OK] pi-web $(pi-web version 2>/dev/null || echo '')" \
    || { err "  [X] pi-web 缺失"; }
    
    if command -v pi >/dev/null 2>&1; then
        local pv; pv="$(pi --version 2>/dev/null || echo '未知')"
        if ver_ge "$pv" "0.84.0"; then
            log "  [OK] Pi Coding Agent $pv (>= 0.84.0)"
        else
            err "  [X] Pi Coding Agent $pv 版本过低（需 >= 0.84.0）"
        fi
    else
        err "  [X] Pi Coding Agent 缺失（jmfederico/pi-web 依赖它）"
    fi
    
    local cfg="${PI_WEB_CONFIG:-$HOME/.config/pi-web/config.json}"
    if [[ -f "$cfg" ]]; then
        log "  [OK] 配置文件 $cfg"
    else
        warn "  [warn] 尚未生成配置文件（$cfg），pi-web install 后生成"
    fi
    
    log "  默认访问: http://127.0.0.1:8024"
    log "  配置参考: ${PI_WEB_CONFIG:-未设置} 或 ~/.config/pi-web/config.json"
    
    if command -v pi-web >/dev/null 2>&1 && [[ $DO_INSTALL -eq 1 ]]; then
        log "  运行 pi-web doctor 做官方自检..."
        pi-web doctor || warn "pi-web doctor 返回非零，请查看上方输出"
    fi
}

# ---------- 主流程 ----------
log "开始部署 jmfederico/pi-web"
check_node
detect_conflict || { err "冲突未解决，部署中止"; exit 1; }
install_pi_web

# set -e 下函数返回非零会终止脚本，故用条件形式接收返回码
svc_rc=0
install_service || svc_rc=$?
if [[ $svc_rc -eq 0 ]]; then
    log "按用户服务部署成功"
    elif [[ $svc_rc -eq 2 ]]; then
    setup_manual_run
else
    err "服务注册失败"
    exit 1
fi
doctor || true
log "部署流程结束"
log "常用命令：pi-web status | logs | restart | doctor | uninstall；或手动运行 ./scripts/pi-web-run.sh start"
