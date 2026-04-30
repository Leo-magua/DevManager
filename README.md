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

## 反向代理选择：proxy.js vs nginx

DevManager 提供了两套可选的反向代理实现，**只能启用其中一个**（默认 `proxy.js`）：

- `proxy.js`（默认）：纯 Node.js 实现，零外部依赖，监听 80 端口。
  start-all.sh 走这条路径。
- 内置 `NginxManager`（`src/services/nginx-manager.js`）：通过 Homebrew nginx
  生成并 reload 配置文件，需要 `sudo`。适合需要 nginx 自带功能（缓存、HTTP/2 等）
  的场景。启用方式：在 config.json 中设置 `proxy.engine = "nginx"` 或
  `DEVMANAGER_PROXY_ENGINE=nginx`，并停止 `proxy.js`。

两者都监听 80 端口，互相冲突。`proxy.js` 启动时已能检测 `EADDRINUSE` 并报错；如果
你打算让 nginx 接管，请显式不启动 `proxy.js`（设置 `DEVMANAGER_DISABLE_PROXY_JS=1`
或不在 start-all.sh 中调用）。

## macOS sudoers 配置（仅在使用 nginx 引擎时需要）

`NginxManager` 需要执行 `sudo nginx -s reload` 等命令。当 DevManager 以 launchd
或后台守护进程方式运行时**没有 TTY**，交互式密码提示会让进程**无声地永久挂起**。

代码会在调用 `sudo` 前自动探测：

1. 进程拥有 TTY → 正常交互输入密码；
2. 否则要求已配置 NOPASSWD，否则立即返回 `SUDO_UNAVAILABLE` 错误。

为后台运行配置 NOPASSWD（替换 `<your-user>` 与 nginx 路径）：

```sh
sudo tee /etc/sudoers.d/devmanager-nginx <<'EOF'
<your-user> ALL=(root) NOPASSWD: /opt/homebrew/bin/nginx, /opt/homebrew/bin/nginx -s reload, /opt/homebrew/bin/nginx -s stop
EOF
sudo chmod 440 /etc/sudoers.d/devmanager-nginx
sudo visudo -cf /etc/sudoers.d/devmanager-nginx  # 校验语法
```

> Apple Silicon 的 Homebrew 路径是 `/opt/homebrew/bin/nginx`；Intel 机器是
> `/usr/local/bin/nginx`。
