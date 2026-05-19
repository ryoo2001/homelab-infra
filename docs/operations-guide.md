# 运维指南

本页记录 HomeLab 的日常维护和故障排查方式。目标很简单：改动能复现，出问题能回退，也能查到原因。

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

公开仓库只保存脱敏后的 `.example.yml` 和 `.example.conf`。

## 常用检查命令

```bash
docker ps
docker network ls
docker network inspect proxy
docker logs reverse-nginx --tail=100
docker exec reverse-nginx nginx -t
docker exec reverse-nginx nginx -s reload
```

## 配置变更流程

1. 修改真实环境配置。
2. 本地检查 Nginx 语法或 Docker Compose 配置。
3. 重载服务。
4. 验证公网、内网、Tailscale 三类访问路径。
5. 记录变更原因和结果。
6. 必要时同步更新对应文档、架构图或截图。

## 备份建议

优先备份这些内容：

- Halo 数据库和附件。
- Uptime Kuma 数据目录。
- AdGuard Home 配置。
- Homepage 配置。
- reverse-nginx 配置。

Homepage 示例在 `examples/compose/homepage/`，里面保留了服务分组、公开/内网区分和允许主机设置。

备份文件不应直接进入公开仓库。公开仓库只记录备份策略，不记录真实备份包。

## 监控项

Uptime Kuma 至少监控：

- `blog.yuuyan.top`
- `status.yuuyan.top`
- 内网关键服务
- Tunnel 可用性
- Nginx 入口服务

公开状态页只显示状态页内容，不暴露内部管理服务清单。

## 故障排查

### 公网访问 502

优先检查：

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

公网域名检查：

- Cloudflare DNS 记录是否存在。
- Tunnel public hostname 是否配置正确。
- `server_name` 是否与访问域名一致。

内网域名检查：

- 客户端 DNS 是否指向 AdGuard Home。
- DNS rewrite 是否包含目标域名。
- NPM proxy host 是否配置正确。

### Homepage 页面不显示服务

优先检查：

- `HOMEPAGE_ALLOWED_HOSTS` 是否包含当前访问域名。
- `services.yaml` 是否和当前环境的域名对齐。
- `widgets.yaml` 或自定义脚本是否引用了不存在的目标。

### Tunnel 不通

检查：

```bash
docker logs cloudflared --tail=100
docker inspect cloudflared
```

常见原因：

- Tunnel token 失效。
- `cloudflared` 容器没有加入 `proxy` 网络。
- Cloudflare public hostname 指向了不存在的服务名。

### Cloudflare Tunnel 连通但页面 404

优先检查：

- `config.example.yml` 里的 hostname 是否和 Nginx `server_name` 一致。
- `reverse-nginx` 是否真的在 `proxy` 网络里。
- 入口路径是否被公共 Nginx 的 `location` 规则拦截。

### Tailscale 能 ping 但服务打不开

常见原因：

- 服务只监听 `127.0.0.1`。
- 防火墙未放行对应端口。
- 容器端口未映射到宿主机。
- 浏览器代理或 DNS 规则影响访问。

### Uptime Kuma 状态页误进后台

公网 Nginx 只允许状态页路径：

- `/status/` 允许代理。
- `/` 跳转到状态页。
- 其他路径返回 `403`。

示例见 [status.yuuyan.top.example.conf](../examples/nginx/status.yuuyan.top.example.conf)。

### Nginx 配置修改后无效

检查：

```bash
docker exec reverse-nginx nginx -t
docker exec reverse-nginx nginx -s reload
docker logs reverse-nginx --tail=100
```

如果使用挂载配置文件，需要确认容器内路径与宿主机路径一致。

