# 故障排查

本页沉淀 HomeLab 常见问题的排查路径。

## 公网访问 502

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

## 域名不解析

公网域名检查：

- Cloudflare DNS 记录是否存在。
- Tunnel public hostname 是否配置正确。
- `server_name` 是否与访问域名一致。

内网域名检查：

- 客户端 DNS 是否指向 AdGuard Home。
- DNS rewrite 是否包含目标域名。
- NPM proxy host 是否配置正确。

## Tunnel 不通

检查：

```bash
docker logs cloudflared --tail=100
docker inspect cloudflared
```

常见原因：

- Tunnel token 失效。
- `cloudflared` 容器没有加入 `proxy` 网络。
- Cloudflare public hostname 指向了不存在的服务名。

## Tailscale 能 ping 但服务打不开

常见原因：

- 服务只监听 `127.0.0.1`。
- 防火墙未放行对应端口。
- 容器端口未映射到宿主机。
- 浏览器代理或 DNS 规则影响访问。

## Uptime Kuma 状态页误进后台

公网 Nginx 应只允许状态页路径：

- `/status/` 允许代理。
- `/` 可跳转到状态页。
- 其他路径返回 `403`。

示例见 [status.yuuyan.top.example.conf](../examples/nginx/status.yuuyan.top.example.conf)。

## Nginx 配置修改后无效

检查：

```bash
docker exec reverse-nginx nginx -t
docker exec reverse-nginx nginx -s reload
docker logs reverse-nginx --tail=100
```

如果使用挂载配置文件，需要确认容器内路径与宿主机路径一致。
