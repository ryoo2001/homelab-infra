# AdGuard Home DNS Rewrite 示例

真实环境中，局域网客户端把 DNS 指向 AdGuard Home。AdGuard Home 将 `*.yuu.lan` 解析到内网反代入口，再由 Nginx Proxy Manager 转发到对应服务。

| 域名 | 示例解析目标 | 用途 |
| --- | --- | --- |
| `home.yuu.lan` | `192.168.1.10` | Homepage |
| `kuma.yuu.lan` | `192.168.1.10` | Uptime Kuma 后台 |
| `npm.yuu.lan` | `192.168.1.10` | Nginx Proxy Manager |
| `adguard.yuu.lan` | `192.168.1.10` | AdGuard Home |

注意：

- `192.168.1.10` 是示例地址，不代表真实内网 IP。
- 管理类域名只应在 LAN 或 Tailscale 中可达。
- 不建议把 `*.yuu.lan` 暴露到公网 DNS。
