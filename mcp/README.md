# HomeLab MCP

这个目录是给个人 HomeLab 用的 MCP 运维服务。通过 SSH 连接白名单主机，提供只读诊断工具、受控变更接口和 OpenClaw 部署管理能力。

## 已有能力

- **主机管理**：概览、健康状态、时间、挂载、磁盘、内存、CPU、网络、进程、端口
- **systemd 服务**：状态、启动、停止、重启、启用、禁用、掩码
- **日志查询**：journal 日志、failed units、systemd timers、错误日志
- **Docker 管理**：容器、镜像、网络、卷、日志、统计信息、生命周期控制
- **Docker Compose**：项目发现、配置校验、状态、日志、拉取、启动、停止、更新
- **OpenClaw 管理**：部署发现、Gateway 探测、日志、doctor、升级、设备、通道、模型、Agent、会话、任务、插件、记忆、OpenClaw 内部 MCP 配置
- **系统操作**：`server_reboot`、`server_firewall`、`server_updates`、`server_selinux`、`server_ping`

## 配置

复制 `.env.example` 为 `.env`，填写主机和 SSH 参数。

```ini
ALLOWED_HOSTS=homolab=192.168.31.178@homolab,server-jp=203.0.113.10@jp-root
SSH_CREDENTIALS=homolab,jp-root
SSH_USER=ops
SSH_PORT=22
SSH_KEY_PATH=C:\\Users\\you\\.ssh\\id_ed25519

# SSH_PASSWORD 仅在未设置 SSH_KEY_PATH 或密钥认证失败时使用。
# SSH_PASSWORD=replace-with-ssh-password

# 主机可引用独立凭据配置，profile 名会转换为 CRED_<ID>_*。
# CRED_HOMOLAB_USER=mcpops
# CRED_HOMOLAB_SSH_PASSWORD=replace-with-homolab-password
# CRED_JP_ROOT_USER=root
# CRED_JP_ROOT_SSH_PASSWORD=replace-with-jp-password

COMPOSE_ROOT=/data/compose

# OpenClaw：本机安装时使用 CLI；Docker Compose 安装时填写 compose 目录。
OPENCLAW_CLI_PATH=openclaw
# OPENCLAW_COMPOSE_DIR=/opt/openclaw
OPENCLAW_CLI_SERVICE=openclaw-cli
OPENCLAW_GATEWAY_SERVICE=openclaw-gateway
OPENCLAW_GATEWAY_CONTAINER=openclaw-gateway

# 仅作为 fallback；openclaw_discover 会优先读取 gateway status 里的实时 probeUrl。
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789

# 可选：白名单特定服务和 Compose 项目（逗号分隔）。留空表示允许所有。
# ALLOWED_SERVICES=nginx,docker,sshd
# ALLOWED_COMPOSE_PROJECTS=web,api,monitoring
```

## 运行

开发态用：

```bash
npm run dev
```

生产态用：

```bash
npm run build
npm run start
```

## OpenClaw 管理工具

OpenClaw 工具支持三种运行方式：

- `mode: "local"`：远端主机已安装 `openclaw` CLI。
- `mode: "compose"`：远端主机用 Docker Compose 运行 OpenClaw，工具通过 `docker compose run --rm -T openclaw-cli ...` 执行 CLI。
- `mode: "auto"`：优先检查 `OPENCLAW_COMPOSE_DIR`，找不到 Compose service 时回退到本机 `OPENCLAW_CLI_PATH`。

只读工具：

- 部署和基础状态：`openclaw_discover`、`openclaw_status`、`openclaw_gateway_probe`、`openclaw_logs`、`openclaw_doctor_lint`
- 通道和模型：`openclaw_channels_status`、`openclaw_channels_list`、`openclaw_channels_logs`、`openclaw_models_status`、`openclaw_models_list`
- Agent、会话和任务：`openclaw_agents_list`、`openclaw_agents_bindings`、`openclaw_sessions_list`、`openclaw_tasks_list`、`openclaw_tasks_audit`、`openclaw_task_show`
- 安全、密钥和插件：`openclaw_secrets_audit`、`openclaw_security_audit`、`openclaw_plugins_list`、`openclaw_plugins_doctor`
- 记忆和 MCP 配置：`openclaw_memory_status`、`openclaw_memory_search`、`openclaw_mcp_list`、`openclaw_mcp_show`
- 设备列表：`openclaw_devices_list`

变更工具：

- `openclaw_doctor_fix`：执行 `openclaw doctor --fix`，可修复配置或状态问题。
- `openclaw_gateway_action`：install/start/stop/restart/uninstall gateway；Compose 模式下映射为 Compose lifecycle。
- `openclaw_update`：本机模式执行 `openclaw update`；Compose 模式执行 `docker compose pull && docker compose up -d`，可选升级后 doctor。
- `openclaw_device_approve`、`openclaw_device_reject`、`openclaw_device_remove`、`openclaw_devices_clear`、`openclaw_device_revoke`、`openclaw_device_rotate`：管理配对设备、令牌撤销和轮换。
- `openclaw_cli`：高权限 OpenClaw CLI 入口，只执行 `openclaw` 或 Compose CLI sidecar，不开放任意 shell。

`OPENCLAW_GATEWAY_URL` 是 fallback。`openclaw_discover` 会读取 `openclaw gateway status --json`，在可用时使用实时 `probeUrl` 检查 `/healthz` 和 `/readyz`。

## Portainer Stack 兼容

Portainer 管理 Compose stack 时，`/data/compose` 可能只有 `1`、`2`、`3` 这类内部目录，且不一定保留可读的 `docker-compose.yml`。Compose 工具会优先读取容器上的 Docker Compose labels：

- `com.docker.compose.project`
- `com.docker.compose.project.working_dir`
- `com.docker.compose.project.config_files`
- `com.docker.compose.service`

工具可以直接用 `homepage`、`adguard-home`、`halo` 这类 stack 名调用。如果没有可读 Compose 文件，返回 `mode: "docker-label"` 并从容器 label 读取配置：

- `compose_projects` 列出 stack 名、Portainer 数字目录、容器、服务和模式。
- `compose_ps` 和 `compose_logs` 按 label 查询容器。
- `compose_pull` 拉取匹配容器正在使用的镜像。
- `compose_up` 和 `compose_down` 只启动或停止匹配容器，不删除 Portainer stack 定义。
- `compose_update` 使用一次性 Watchtower（`DOCKER_API_VERSION=1.40`）更新并重建匹配容器。

## 权限边界

- `mcpops` 只放行白名单主机。
- `sudoers` 只放行需要的 systemd 和防火墙命令。
- Docker 访问通过 `docker` 组或单独 sudoers 授权。
- OpenClaw 工具只调用 `openclaw` CLI 或 Compose CLI sidecar，不提供任意 shell 执行。
- 可选白名单限制特定 systemd 服务和 Compose 项目。

## 安全特性

- **输出限制**：SSH 命令输出限制 1MB，防止内存溢出。
- **审计日志**：所有 destructive 操作记录到 `mcp/audit.log`。
- **白名单控制**：可选的服务和 Compose 项目白名单。
- **密钥优先**：优先使用 SSH 密钥认证，密码作为备选。
- **参数约束**：OpenClaw 路径、服务名、环境变量和 CLI 参数都经过 schema 校验。

## 不要提交的本地文件

这些内容应保留在本地，不进仓库：

- `mcp/.env`
- `mcp/dist/`
- `mcp/node_modules/`
- `mcp/audit.log`
- 任何本机私钥文件
