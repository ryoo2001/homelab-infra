# 运维指南

本页记录 HomeLab 的日常维护和故障排查方式。目标很简单：改动能复现，出问题能回退，也能查到原因。

本文假设读者已了解双 Nginx 入口设计，详见 [dual-nginx-design.md](dual-nginx-design.md)。

## 目录约定

真实环境按服务拆分 Compose 项目：

```text
/data/compose/
├── reverse-nginx/
├── cloudflared/
├── halo/
├── uptime-kuma/
├── homepage/
├── adguardhome/
├── nginx-proxy-manager/
└── portainer/
```

公开仓库只保存脱敏后的 `.example.yml` 和 `.example.conf`。Nginx 配置文件布局见[双 Nginx 入口架构 · 配置组织](dual-nginx-design.md#配置组织)。

## 常用检查命令

**reverse-nginx**

```bash
docker ps
docker network ls
docker network inspect proxy
docker logs reverse-nginx --tail=100
docker exec reverse-nginx nginx -t
docker exec reverse-nginx nginx -s reload
```

**cloudflared**

```bash
docker logs cloudflared --tail=100
docker inspect cloudflared
```

**Nginx Proxy Manager**

```bash
docker logs nginx-proxy-manager --tail=100
```

**AdGuard Home**

```bash
docker logs adguardhome --tail=100
```

**Uptime Kuma**

```bash
docker logs uptime-kuma --tail=100
```

**WireGuard**

```bash
sudo wg show
```

**DDNS-Go**

```bash
docker logs ddns-go --tail=100
```

## 配置变更流程

1. 修改真实环境配置。
2. 检查配置语法：
   - Nginx：`docker exec reverse-nginx nginx -t`
   - Compose：`docker compose config`（在对应服务目录执行）
3. 重载服务。
4. 验证公网、内网、WireGuard 三类访问路径。变更前可参考[职责边界](dual-nginx-design.md#职责边界)确认影响范围。
5. 记录变更原因和结果。
6. 必要时同步更新对应文档、架构图或截图。

## 备份建议

优先备份这些内容（数据路径均在 `/data/compose/<service>/` 下）：

- Halo 数据库和附件（`/data/compose/halo/`）。
- Uptime Kuma 数据目录（`/data/compose/uptime-kuma/`）。
- AdGuard Home 配置（`/data/compose/adguardhome/`）。
- Homepage 配置（`/data/compose/homepage/`）。
- reverse-nginx 配置（`/data/compose/reverse-nginx/`）。

Homepage 示例在 `examples/compose/homepage/`，里面保留了服务分组、公开/内网区分和允许主机设置。

备份文件不应直接进入公开仓库。公开仓库只记录备份策略，不记录真实备份包。自动化备份策略尚未配置，见 README 待补充项。

## 监控项

Uptime Kuma 至少监控：

- 公网博客和状态页
- 内网关键服务
- Tunnel 可用性
- Nginx 入口服务

Uptime Kuma 管理界面通过内网（`kuma.yuu.lan`）或 WireGuard VPN 访问，监控项在 Web UI 中配置。公开状态页只显示状态页内容，不暴露内部管理服务清单。

## 故障排查

### 公网访问 502

```bash
docker ps
docker logs reverse-nginx --tail=100
docker exec reverse-nginx nginx -t
docker network inspect proxy
```

常见原因：

- 后端容器未运行。
- 后端容器未加入 `proxy` 网络。
- `proxy_pass` 使用的容器名或端口错误。
- Cloudflare Tunnel 指向的服务名错误。

### 域名不解析

公网域名：

```bash
dig <domain>
```

检查：

- Cloudflare DNS 记录是否存在。
- Tunnel public hostname 是否配置正确。
- `server_name` 是否与访问域名一致。

内网域名：

```bash
nslookup <domain> <adguard-ip>
```

检查：

- 客户端 DNS 是否指向 AdGuard Home。
- DNS rewrite 是否包含目标域名。
- NPM proxy host 是否配置正确。

### Homepage 页面不显示服务

```bash
docker logs homepage --tail=100
```

常见原因：

- `HOMEPAGE_ALLOWED_HOSTS` 未包含当前访问域名。
- `services.yaml` 与当前环境域名不对齐。
- `widgets.yaml` 或自定义脚本引用了不存在的目标。

### Tunnel 不通

```bash
docker logs cloudflared --tail=100
docker inspect cloudflared
```

常见原因：

- Tunnel token 失效。
- `cloudflared` 容器没有加入 `proxy` 网络。
- Cloudflare public hostname 指向了不存在的服务名。

### Cloudflare Tunnel 连通但页面 404

```bash
docker exec reverse-nginx nginx -t
docker network inspect proxy
```

检查：

- Cloudflare 控制台中 public hostname 配置的服务名是否与 Nginx `server_name` 一致（注意区分仓库中的 `.example.yml` 示例文件与实际运行配置）。
- `reverse-nginx` 是否在 `proxy` 网络里。
- 入口路径是否被 Nginx 的 `location` 规则拦截。

### Nginx Proxy Manager 内网入口异常

```bash
docker logs nginx-proxy-manager --tail=100
docker network inspect proxy
```

常见原因：

- NPM proxy host 配置的后端地址或端口错误。
- 后端容器未加入 `proxy` 网络。
- SSL 证书过期或配置错误。
- NPM 访问列表规则阻止了请求。

### WireGuard 能 ping 但服务打不开

```bash
sudo wg show
sudo firewall-cmd --list-all
```

常见原因：

- 服务只监听 `127.0.0.1`。
- 防火墙未放行对应端口。
- 容器端口未映射到宿主机。
- WireGuard 客户端 AllowedIPs 不包含目标子网。
- 路由器端口转发未正确映射 51820/udp。
- DDNS-Go 域名解析未更新（IP 变动后）。
- 浏览器代理或 DNS 规则影响访问。

### WireGuard Endpoint 被 Clash / Mihomo fake-ip 影响

客户端日志可能出现：

```text
Sending handshake initiation to peer 1 (198.18.0.38:51820)
Handshake did not complete after 5 seconds
```

`198.18.0.0/15` 是保留网段，常见于 Clash / Mihomo 的 fake-ip DNS。出现这种地址通常说明 WireGuard Endpoint 域名被解析成了代理假 IP，而不是家庭宽带的真实公网地址。

处理：

1. 临时把客户端 `Endpoint` 改成真实公网 IP，确认 WireGuard 本身可连。
2. 在 Clash / Mihomo 中给 DDNS 域名加直连规则。
3. 如果使用 fake-ip，给 DDNS 域名加入 fake-ip 过滤。

示例：

```yaml
rules:
  - DOMAIN,vpn.yuuyan.top,DIRECT

fake-ip-filter:
  - vpn.yuuyan.top
```

### Uptime Kuma 状态页误进后台

公网 Nginx 只允许状态页路径：

- `/status/` 允许代理。
- `/` 跳转到状态页。
- 其他路径返回 `403`。

示例见 [status.yuuyan.top.example.conf](../examples/nginx/status.yuuyan.top.example.conf)。

### Nginx 配置修改后无效

```bash
docker exec reverse-nginx nginx -t
docker exec reverse-nginx nginx -s reload
docker logs reverse-nginx --tail=100
```

如果使用挂载配置文件，检查实际挂载路径：

```bash
docker inspect reverse-nginx | grep -A 20 Mounts
```

容器内配置路径通常为 `/etc/nginx/conf.d/`，确认宿主机挂载路径与之一致。

## 相关文档

- [双 Nginx 入口架构](dual-nginx-design.md)
- [WireGuard + DDNS-Go 私有管理链路](wireguard-ddnsgo-design.md)
- [README.md](../README.md)
- [Nginx 示例配置](../examples/nginx/)
- [Compose 示例](../examples/compose/)
