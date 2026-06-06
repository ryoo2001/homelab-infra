# MCP 配置优化说明

本文档记录了 HomeLab MCP 服务的配置最佳实践和安全要求。

## 配置文件管理

### 生产配置（敏感信息）

包含真实凭据的配置文件应**仅保存在本地**，不提交到 git：

- `mcp/lobehub-mcp-config.json` - LobeHub MCP 客户端配置
- `mcp/.env` - 环境变量配置
- `mcp/audit.log` - 审计日志

这些文件已在 `.gitignore` 中排除。

### 示例配置（公开）

提供模板文件供参考：

- `mcp/lobehub-mcp-config.example.json` - LobeHub 配置示例
- `mcp/.env.example` - 环境变量示例

使用时复制示例文件并填写真实凭据：

```bash
cp mcp/lobehub-mcp-config.example.json mcp/lobehub-mcp-config.json
cp mcp/.env.example mcp/.env
```

## 安全检查清单

部署前务必确认：

- [ ] 敏感配置文件不在 git 中（运行 `git ls-files mcp/lobehub-mcp-config.json` 应无输出）
- [ ] `.gitignore` 包含所有敏感文件
- [ ] SSH 优先使用密钥认证，密码仅作备选
- [ ] 主机白名单已正确配置（`ALLOWED_HOSTS`）
- [ ] 可选白名单已设置（`ALLOWED_SERVICES`、`ALLOWED_COMPOSE_PROJECTS`）
- [ ] sudoers 已配置最小权限
- [ ] 审计日志权限仅限所有者读写

## 配置方式对比

| 方式 | 适用场景 | 优点 | 缺点 |
|------|---------|------|------|
| `.env` 文件 | CLI 直接运行 | 统一管理，易于编辑 | 需要手动维护 |
| LobeHub JSON | LobeHub/Claude Desktop | 可视化配置 | 多个配置文件 |
| 环境变量 | 容器/系统服务 | 隔离性好 | 调试不便 |

## 推荐实践

1. **开发环境**：使用 `.env` 文件，运行 `npm run dev`
2. **生产环境**：
   - 系统服务：使用 systemd EnvironmentFile
   - LobeHub：使用 `lobehub-mcp-config.json`
   - 容器：使用 docker-compose environment 或 secrets
3. **凭据轮换**：
   - 定期更换 SSH 密码
   - 使用 `openclaw_device_rotate` 轮换 OpenClaw 令牌
   - 审计日志保留至少 90 天

## 故障排查

### 连接失败

```bash
# 测试 SSH 连接
ssh -i ~/.ssh/id_ed25519 mcpops@192.168.31.178

# 检查 MCP 服务日志
journalctl -u homolab-mcp -n 50
```

### 权限问题

```bash
# 验证 sudoers 配置
sudo -l -U mcpops

# 测试无密码 sudo
sudo -n systemctl status docker
```

### 配置验证

```bash
# 验证 .env 语法
dotenv -f mcp/.env list

# 验证 JSON 配置
jq empty mcp/lobehub-mcp-config.json
```

## 参考文档

- [MCP 服务 README](../README.md)
- [个人运维助手文档](docs/personal-ops-assistant.md)
- [MCP 运维账号配置](../../docs/mcp-ops-account.md)
