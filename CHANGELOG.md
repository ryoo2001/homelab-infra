# Changelog

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
