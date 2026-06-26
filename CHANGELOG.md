# Changelog

[← 返回 README](README.md)

## 2026-06-26

- 外网入口从原生 `reverse-nginx` 迁移至 1Panel OpenResty（`1Panel-openresty-M3iP`）。
- Portainer 移除，Docker 管理统一到 1Panel 集成面板。
- Docker 网络从单一 `proxy` 拆分为 `public_proxy`（外网入口层）和 `internal_proxy`（内网入口层）。
- Cloudflare Tunnel 回源目标调整为 `http://public-openresty:80`。
- 1Panel OpenResty 配置迁移至 `/opt/1panel/www/conf.d/`，反向代理规则拆分至各站点 `proxy/` 目录。
- 修复 `blog.yuuyan.top` 启用1Panel 证书后的重定向循环（HTTPS 策略改为 `HTTPAlso`）。
- 内网域名（`*.yuu.lan`）暂停启用，内网服务改以 IP 直接访问。
- 更新 README、dual-nginx-design.md、operations-guide.md 反映迁移后架构。

## 2026-06-02

- MCP 运维服务新增 OpenClaw 管理能力：
  - 部署发现、Gateway 探测、日志、doctor、升级、设备审批和 CLI 管理工具。
  - 通道、模型、Agent、会话、任务、安全审计、插件、记忆和 OpenClaw 内部 MCP 配置查询工具。
  - 在 `README.md`、`mcp/README.md`、`docs/mcp-ops-account.md` 和 `mcp/docs/personal-ops-assistant.md` 中明确 OpenClaw 权限边界和 destructive 操作范围。

## 2026-05-22

- MCP 运维服务重构与优化：
  - 拆分 1660 行单文件为 9 个模块（config, helpers, ssh, tools/*），职责清晰。
  - 新增 `runBatch()` 合并多次 SSH 调用，7 个工具从 24 次 → 7 次握手。
  - 新增 `readonlyTool` / `destructiveTool` 注册 helper，消除 ~150 行样板代码。
  - 新增 SSH 输出 1MB 限制，防止内存溢出。
  - 新增 destructive 操作审计日志（`mcp/audit.log`）。
  - 新增可选白名单配置（`ALLOWED_SERVICES` / `ALLOWED_COMPOSE_PROJECTS`）。
  - 更新 `.env.example`，注释 `SSH_PASSWORD`，添加安全说明。
  - 更新 `mcp/README.md` 和 `docs/mcp-ops-account.md`，反映最新功能。

## 2026-05-21

- 私有管理链路从 Tailscale 迁移到 WireGuard (host-level) + DDNS-Go (Docker)。
- 新增 WireGuard + DDNS-Go 私有管理链路设计文档。
- 更新 README、架构图和相关文档中的 Tailscale 引用。
- 新增 DDNS-Go Compose 示例。
- 归档旧版首页至 docs/archive/。

## 2026-05-19

- 初始化脱敏后的 HomeLab 文档和示例配置。
- 添加 README、架构文档、双 Nginx 分流说明和 Docker 网络隔离说明。
- 添加 Mermaid 架构图源码。
- 添加脱敏 Compose、Nginx 和 DNS rewrite 示例。
