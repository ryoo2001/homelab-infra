# 个人运维助手设计

这个 MCP 服务面向单人 HomeLab 运维，目标是让 agent 能稳定、安全地管理 Linux 主机。

## 设计原则

1. 只管理白名单主机。
2. 只管理白名单 systemd 服务。
3. 默认只读，变更操作单独暴露。
4. 不开放任意 shell 执行。
5. SSH 连接全部通过密钥认证。

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

## 后续可以加的能力

- `backup_status`

## 部署建议

- 本地客户端：`stdio`
- 多客户端共享：`streamable HTTP`
- SSH 认证：专用运维账号 + `sudo` 白名单
- 审计：把重启类操作写入本地日志或外部日志系统
