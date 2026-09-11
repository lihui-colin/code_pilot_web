# pi-web

## 更新

```bash
# 更新 pi agent + @jmfederico/pi-web；若服务在跑则先停再装再拉起
./scripts/pi-web-run-jmfederico.sh update

# 只更新其中一项
./scripts/pi-web-run-jmfederico.sh update --pi-only
./scripts/pi-web-run-jmfederico.sh update --web-only

# 指定版本 / 不重启 / 同步 relay skill
PI_VERSION=0.85.1 PI_WEB_VERSION=1.202609.0 ./scripts/pi-web-run-jmfederico.sh update
./scripts/pi-web-run-jmfederico.sh update --no-restart
./scripts/pi-web-run-jmfederico.sh update --update-relay
./scripts/pi-web-run-jmfederico.sh update --dry-run
```

`update` 复用 `scripts/update-pi-web-jmfederico.sh` 的升级流程。本机无 systemd user 总线时，由运行脚本管理 sessiond + server。

## 配置

```text
~/.config/pi-web/config.json
{
  "spawnSessions": true,
  "subsessions": true,
  "askUser": true,

  "plugins": {
    "relays": {
      "enabled": true
    }
  }
}
必须重启服务才能生效
```

## 安装relay skill

npx skills add jmfederico/pi-web --skill relay -a pi -g

## relay prompt

放在代码根目录  
参考: https://github.com/jmfederico/pi-web/tree/main/.pi/prompts

.pi/prompts/relay.md 是 /relay 的启动模板，它负责规划 Relay 并 dispatch 第一个 leg。

## 备注

skills/relay/SKILL.md 是 Relay 的方法论，定义了接力规则、charter.md、status.md、log.md 和 spawn_session 的 handoff 规则
