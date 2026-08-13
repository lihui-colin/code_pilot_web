# pi-web

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
