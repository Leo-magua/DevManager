# AllProject DevManager

DevManager 是本机 AllProject 目录的项目管理与部署看板。

## 当前入口

- PersonalWork 对外入口：`http://localhost/`
- DevManager 管理后台：`http://localhost:81/`
- PersonalWork 真实前端端口：`3991`
- 80 端口是 `proxy.js` 反向代理入口，不是真实业务项目端口

## 启动

```bash
./start-all.sh
```

脚本会重启 DevManager 和 PersonalWork，并保留已有的 80 端口代理。
如果 80 端口没有代理在运行，脚本只会提示手动 sudo 命令，不会自动回退到 8888。

## 停止与状态

```bash
./stop-all.sh
./status.sh
```

## 主要目录

```text
src/                 Express 后端、任务队列、部署管理、WebSocket
public/              浏览器看板
proxy.js             80 端口统一入口反向代理
start-all.sh         一键启动 DevManager + PersonalWork
stop-all.sh          停止脚本
status.sh            端口状态检查
config.json          项目配置
data/                运行时临时数据
logs/                部署日志
```

## 部署模型

```text
http://localhost/                 -> proxy.js:80 -> PersonalWork:3991
http://localhost/<project>/        -> proxy.js:80 -> 子项目配置端口
http://localhost:81/               -> DevManager
```

子项目端口和路由来自各项目的 `.devmanager/nginx-config.json`。
