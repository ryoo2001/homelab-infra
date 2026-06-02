# 个人运维助手设计

这个 MCP 服务面向单人 HomeLab 运维，通过白名单和只读优先策略提供受控的 Linux 主机管理能力。

## 设计原则

1. 只管理白名单主机和白名单 systemd 服务。
2. 默认只读，变更操作单独暴露。
3. 不开放任意 shell 执行。
4. SSH 连接全部通过密钥认证。
5. OpenClaw 管理只通过 `openclaw` CLI 或 Compose CLI sidecar，不扩展为通用远程 shell。

## 推荐工具

- `server_list`
- `server_status`
- `server_health`
- `server_info`
- `service_status`
- `service_restart`
- `server_logs`
- `docker_ps`
- `docker_logs`
- `docker_stats`
- `docker_restart`
- `compose_ps`
- `compose_logs`
- `compose_up`
- `compose_down`
- `openclaw_discover`
- `openclaw_status`
- `openclaw_gateway_probe`
- `openclaw_logs`
- `openclaw_doctor_lint`
- `openclaw_channels_status`
- `openclaw_models_status`
- `openclaw_agents_list`
- `openclaw_sessions_list`
- `openclaw_tasks_list`
- `openclaw_secrets_audit`
- `openclaw_security_audit`
- `openclaw_plugins_doctor`
- `openclaw_memory_status`
- `openclaw_mcp_list`

## OpenClaw 变更工具

这些工具会修改 OpenClaw 配置、服务状态、设备令牌、插件/任务状态或 Compose stack，按 destructive 操作处理并写入审计日志：

- `openclaw_doctor_fix`
- `openclaw_gateway_action`
- `openclaw_update`
- `openclaw_device_approve`
- `openclaw_device_reject`
- `openclaw_device_remove`
- `openclaw_devices_clear`
- `openclaw_device_revoke`
- `openclaw_device_rotate`
- `openclaw_cli`

## 后续可以加的能力

- `backup_status`

## 部署建议

- 本地客户端：`stdio`
- 多客户端共享：`streamable HTTP`
- SSH 认证：专用运维账号 + `sudo` 白名单
- 审计：把重启类操作写入本地日志或外部日志系统
- OpenClaw：本机 CLI 用 `OPENCLAW_CLI_PATH`，Compose 部署用 `OPENCLAW_COMPOSE_DIR`、`OPENCLAW_CLI_SERVICE` 和 `OPENCLAW_GATEWAY_SERVICE`
