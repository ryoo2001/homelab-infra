# 安全访问控制设计

HomeLab 的安全目标是减少公网暴露面。不同风险等级的服务放在不同入口里，不混在一条链路上。

## 服务分级

| 等级 | 服务类型 | 访问方式 |
| --- | --- | --- |
| 公开访问 | 博客前台、公开状态页 | `yuuyan.top` 子域名 |
| 认证访问 | 偶尔需要外部访问的入口 | Cloudflare Access |
| 私有管理 | SSH、Portainer、AdGuard、NPM、后台面板 | LAN 或 Tailscale |

## 公网公开原则

公网只放低风险内容：

- Halo 前台可以公开。
- Uptime Kuma 只公开状态页，不公开控制台。
- Homepage 如果展示内部服务清单，只放在内网入口。

仓库中的 Homepage 样例只保留分组和入口结构。

所有公网流量应先经过 Cloudflare，再通过 Tunnel 进入内网。家庭宽带侧不直接开放 80/443。

Cloudflare 的公开入口样例只保留 hostname 和转发目标。

## Cloudflare Access

Cloudflare Access 用在半公开入口，例如需要认证才能访问的页面。

Access 策略不写入公开仓库，仓库里只记录入口类型和用途。

## Tailscale

Tailscale 用于私有管理链路：

- SSH
- Portainer
- Nginx Proxy Manager 管理页面
- AdGuard Home 管理页面
- Uptime Kuma 控制台

公开仓库不记录真实 Tailscale IP、设备名、auth key 或 ACL 敏感内容。

## 脱敏规则

| 真实内容 | 公开样例 |
| --- | --- |
| Tunnel token | `${TUNNEL_TOKEN}` |
| 数据库密码 | `${DB_PASSWORD}` |
| 内网 IP | `192.168.1.10` |
| Tailscale IP | `100.x.x.x` |
| 后台域名 | `protected.yuuyan.top` 或 `admin.example.internal` |
| API token | `${API_TOKEN}` |

## 提交前检查

提交公开仓库前至少检查：

```bash
git grep -n "token\\|password\\|secret\\|authkey\\|100\\."
git grep -n "192\\.168\\|10\\.0\\|172\\.16"
```

这些命令用来找可能遗留的敏感内容。命中结果需要人工判断：示例占位符可以保留，真实凭据和真实私有地址不能保留。
