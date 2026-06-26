# MCP 运维账号方案

这份方案用于给 HomeLab 的 MCP 运维助手单独创建一个 Linux 账号，避免和日常登录账号混用。

## 目标

- 限定 MCP 访问范围至白名单主机和服务
- 将权限收敛到专用账号，密钥登录优先，密码作为备选
- 限制可执行操作为日志读取、状态查询和受控的重启/管理动作

## 推荐账号

示例账号名：`mcpops`

### 账号职责

- 运行 MCP 通过 SSH 调用的受控命令
- 读取 systemd 日志
- 重启白名单里的 systemd 服务
- 读取 Docker / Compose 状态
- 通过 1Panel V2 API Key 查询面板中的应用和网站状态
- 通过 `openclaw` CLI 或 OpenClaw Compose sidecar 管理 OpenClaw

### 不做的事

- 不作为个人日常 shell 账号
- 不授予完整 sudo
- 不开放任意命令执行
- 不复用 1Panel Web 登录会话
- 不把 OpenClaw 管理能力扩展成通用 shell 跳板

## 创建方式

### 方案一：密钥登录（推荐）

更安全，适合长期使用。

```bash
sudo useradd -m -s /bin/bash mcpops
sudo mkdir -p /home/mcpops/.ssh
sudo chmod 700 /home/mcpops/.ssh
sudo chown -R mcpops:mcpops /home/mcpops/.ssh
```

把公钥放进：

```text
/home/mcpops/.ssh/authorized_keys
```

然后：

```bash
sudo chmod 600 /home/mcpops/.ssh/authorized_keys
sudo chown mcpops:mcpops /home/mcpops/.ssh/authorized_keys
```

MCP 配置：

```ini
SSH_USER=mcpops
SSH_KEY_PATH=C:\\Users\\you\\.ssh\\id_ed25519
```

### 方案二：密码登录（备选）

适合快速测试或密钥认证失败时的备选方案。

```bash
sudo useradd -m -s /bin/bash mcpops
sudo passwd mcpops
```

MCP 配置（取消注释）：

```ini
SSH_USER=mcpops
# SSH_PASSWORD=你的SSH密码
```

## 需要的权限

### 读取日志

如果希望 `mcpops` 直接读 journal，通常加到：

```bash
sudo usermod -aG systemd-journal mcpops
```

有些发行版还会用到：

```bash
sudo usermod -aG adm mcpops
```

### systemd 白名单

建议用 `/etc/sudoers.d/mcpops` 单独放行，例如：

```sudoers
mcpops ALL=(root) NOPASSWD: /bin/systemctl restart nginx, /bin/systemctl restart docker, /bin/systemctl restart wg-quick@wg0, /bin/systemctl start nginx, /bin/systemctl stop nginx, /bin/systemctl reload nginx, /bin/systemctl enable nginx, /bin/systemctl disable nginx, /bin/systemctl mask nginx, /bin/systemctl unmask nginx
mcpops ALL=(root) NOPASSWD: /bin/systemctl reboot
```

如果你要让 MCP 读防火墙状态，也可以单独放行：

```sudoers
mcpops ALL=(root) NOPASSWD: /usr/bin/firewall-cmd --state, /usr/bin/firewall-cmd --get-active-zones, /usr/bin/firewall-cmd --list-all
```

**提示**：MCP 支持可选的服务白名单（`ALLOWED_SERVICES`），可以在应用层进一步限制允许操作的服务，即使 sudoers 放行了更多服务。

### Docker

Docker 相关工具需要远端账号能访问 Docker socket，常见做法是：

```bash
sudo usermod -aG docker mcpops
```

### OpenClaw

OpenClaw 工具有两种常用授权方式：

- 本机 CLI 模式：远端账号能执行 `openclaw`，并能读取 OpenClaw 配置、状态、日志和 gateway 信息。
- Docker Compose 模式：远端账号能进入 `OPENCLAW_COMPOSE_DIR`，并能执行 `docker compose run --rm -T openclaw-cli ...` 和 gateway lifecycle 相关 Compose 命令。

如果 OpenClaw gateway 由 systemd 管理，可以在 sudoers 中只放行对应服务，例如：

```sudoers
mcpops ALL=(root) NOPASSWD: /bin/systemctl start openclaw-gateway, /bin/systemctl stop openclaw-gateway, /bin/systemctl restart openclaw-gateway, /bin/systemctl status openclaw-gateway
```

如果 OpenClaw 由 Docker Compose 管理，推荐优先使用 `docker` 组或受限 Docker sudoers，而不是授予完整 sudo。`openclaw_cli` 只会执行 OpenClaw CLI 或 Compose CLI sidecar；但它仍属于高权限入口，因为 OpenClaw 子命令可能修改配置、设备、插件、任务或 gateway 状态。

### 1Panel API

1Panel API 工具不需要额外 sudoers。它们通过 SSH 在目标主机上调用 `ONEPANEL_URL`，并使用 `ONEPANEL_API_KEY` 生成 1Panel V2 要求的 `1Panel-Token` 和 `1Panel-Timestamp` 请求头。

建议为 MCP 单独生成 API Key，并只把真实值放在本地 `mcp/.env` 或生产环境变量中，不提交到仓库。当前封装的 1Panel 专用工具以只读查询为主；`onepanel_api` 是受限原始入口，只允许 `GET` 或已确认只读的白名单 `POST` 路径，调用前仍应确认端点语义。

## SSH 限制

建议只允许这个账号从 LAN 或 WireGuard 登录。

```sshconfig
Match User mcpops
  PasswordAuthentication yes
  PubkeyAuthentication yes
  X11Forwarding no
  AllowTcpForwarding no
  PermitTTY no
```

## 安全特性

MCP 运维服务对 SSH 命令输出设置 1MB 限制以防止内存溢出。所有 destructive 操作自动写入 `mcp/audit.log`。可选的 `ALLOWED_SERVICES` 和 `ALLOWED_COMPOSE_PROJECTS` 环境变量进一步限制操作范围。SSH 认证优先使用密钥，密码作为备选。1Panel API 路径、OpenClaw 路径、服务名、环境变量和 CLI 参数经过 schema 校验，工具只调用 1Panel API、`openclaw` CLI 或 Compose sidecar。

## 相关文档

- [mcp/README.md](../mcp/README.md)
- [个人运维助手设计](../mcp/docs/personal-ops-assistant.md)
- [README.md](../README.md)

## 不要追踪的本地文件

详见 [mcp/README.md · 不要提交的本地文件](../mcp/README.md#不要提交的本地文件)。
