# MCP 运维账号方案

这份方案用于给 HomeLab 的 MCP 运维助手单独创建一个 Linux 账号，避免和日常登录账号混用。

## 目标

- 只允许 MCP 访问需要的主机
- 只允许读取日志、状态和少量重启/管理动作
- 将权限收敛到一个专用账号
- 优先使用密钥登录，密码作为备选

## 推荐账号

示例账号名：`mcpops`

### 账号职责

- 运行 MCP 通过 SSH 调用的受控命令
- 读取 systemd 日志
- 重启白名单里的 systemd 服务
- 读取 Docker / Compose 状态

### 不做的事

- 不作为个人日常 shell 账号
- 不授予完整 sudo
- 不开放任意命令执行

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

MCP 运维服务内置以下安全机制：

- **输出限制**：SSH 命令输出限制 1MB，防止内存溢出
- **审计日志**：所有 destructive 操作自动记录到 `mcp/audit.log`
- **白名单控制**：可选的 `ALLOWED_SERVICES` 和 `ALLOWED_COMPOSE_PROJECTS` 环境变量
- **密钥优先**：优先使用 SSH 密钥认证，密码作为备选

## 对应仓库文件

- [mcp/README.md](../mcp/README.md)
- [README.md](../README.md)

## 不要追踪上传的文件

这些本地文件应保留在机器上，不进仓库：

- `mcp/.env`
- `mcp/node_modules/`
- `mcp/dist/`
- `mcp/audit.log`
- 任何 SSH 私钥

