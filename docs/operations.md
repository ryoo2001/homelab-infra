# 运维流程

本页记录 HomeLab 的日常维护方式，重点是可重复、可回滚和可排查。

## 目录约定

建议真实环境中按服务拆分 Compose 项目：

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

优先备份：

- Halo 数据库和附件。
- Uptime Kuma 数据目录。
- AdGuard Home 配置。
- Homepage 配置。
- reverse-nginx 配置。

备份文件不应直接进入公开仓库。公开仓库只记录备份策略，不记录真实备份包。

## 监控建议

Uptime Kuma 至少监控：

- `blog.yuuyan.top`
- `status.yuuyan.top`
- 内网关键服务
- Tunnel 可用性
- Nginx 入口服务

公开状态页只展示用户可理解的服务状态，不展示内部管理服务清单。
