# HomeLab MCP

这个目录是给个人 HomeLab 用的 MCP 运维服务，默认通过 SSH 连接到白名单主机，提供只读诊断和少量受控操作。

## 已有能力

- **主机管理**：概览、健康状态、时间、挂载、磁盘、内存、CPU、网络、进程、端口
- **systemd 服务**：状态、启动、停止、重启、启用、禁用、掩码
- **日志查询**：journal 日志、failed units、systemd timers、错误日志
- **Docker 管理**：容器、镜像、网络、卷、日志、统计信息、生命周期控制
- **Docker Compose**：项目发现、配置校验、状态、日志、拉取、启动、停止
- **系统操作**：`server_reboot`、`server_firewall`、`server_updates`、`server_selinux`、`server_ping`

## 配置

复制 `.env.example` 为 `.env`，填写主机和 SSH 参数。

```ini
ALLOWED_HOSTS=192.168.31.178
SSH_USER=mcpops
SSH_PORT=22
SSH_KEY_PATH=C:\\Users\\you\\.ssh\\id_ed25519

# SSH_PASSWORD 仅在密钥认证失败时使用，建议优先使用密钥
# SSH_PASSWORD=replace-with-ssh-password

COMPOSE_ROOT=/data/compose

# 可选：白名单特定服务和 Compose 项目（逗号分隔）
# 留空表示允许所有
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

## 权限边界

- `mcpops` 只放行白名单主机
- `sudoers` 只放行需要的 systemd 和防火墙命令
- Docker 访问通过 `docker` 组或单独 sudoers 授权
- 不提供任意 shell 执行
- 可选白名单限制特定服务和 Compose 项目

## 安全特性

- **输出限制**：SSH 命令输出限制 1MB，防止内存溢出
- **审计日志**：所有 destructive 操作记录到 `mcp/audit.log`
- **白名单控制**：可选的服务和 Compose 项目白名单
- **密钥优先**：优先使用 SSH 密钥认证，密码作为备选

## 不要提交的本地文件

这些内容应保留在本地，不进仓库：

- `mcp/.env`
- `mcp/dist/`
- `mcp/node_modules/`
- `mcp/audit.log`
- 任何本机私钥文件

