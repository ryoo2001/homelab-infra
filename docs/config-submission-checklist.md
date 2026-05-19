# 配置样例提交清单

后续如果要把真实 HomeLab 配置整理成公开样例，可以先把文件提供给我。我会进行脱敏、注释和样例化，再放入 `examples/` 对应目录。

## 优先提供

```text
reverse-nginx/
├── docker-compose.yml
├── nginx.conf
└── conf.d/
    ├── blog.yuuyan.top.conf
    ├── status.yuuyan.top.conf
    ├── home.yuuyan.top.conf
    └── 其他有展示价值的 conf
```

```text
cloudflared/
├── docker-compose.yml
└── config.yml
```

如果使用 token 方式运行 Cloudflare Tunnel，`config.yml` 可以没有，但不要把真实 token 直接提交到公开仓库。

## 建议提供

```text
uptime-kuma/
└── docker-compose.yml
```

```text
homepage/
├── docker-compose.yml
└── config/
    ├── services.yaml
    ├── settings.yaml
    ├── widgets.yaml
    └── bookmarks.yaml
```

```text
adguardhome/
├── docker-compose.yml
└── DNS Rewrite 截图或导出的规则说明
```

```text
nginx-proxy-manager/
└── docker-compose.yml
```

## 可选提供

```text
halo/
└── docker-compose.yml
```

```text
portainer/
└── docker-compose.yml
```

```text
tailscale/
└── 只提供访问策略说明，不提供真实设备名、真实 IP、auth key 或 ACL 敏感内容
```

## 不要提供或不要直接上传

```text
.env
*.key
*.pem
cloudflared token
数据库密码
Cloudflare API Token
Tailscale auth key
真实后台域名
真实管理路径
真实内网 IP 完整表
Mihomo 订阅、节点或代理配置
```

## 样例化规则

- 真实密钥替换为 `${VARIABLE_NAME}`。
- 内网 IP 替换为 `192.168.1.10`、`192.168.1.20` 等示例地址。
- Tailscale IP 替换为 `100.x.x.x`。
- 后台域名替换为 `protected.yuuyan.top` 或 `admin.example.internal`。
- 保留 `yuuyan.top`、`blog.yuuyan.top`、`status.yuuyan.top` 作为公开展示案例。
- 文件改名为 `.example.yml`、`.example.conf` 或 `.example.md`。
- 在关键配置旁添加简短注释，说明它服务于公网链路、内网链路还是私有管理链路。
