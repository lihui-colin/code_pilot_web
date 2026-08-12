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
