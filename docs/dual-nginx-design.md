# 双 Nginx 分流设计

本项目同时使用原生 Nginx 与 Nginx Proxy Manager，但两者不是重复建设，而是服务于不同访问边界。

如果改用传统 DNS 的内外网分流方案，一般需要额外搭建和维护 DNS 服务器，承担分视图解析或局域网重写。考虑稳定性、维护成本和本项目轻量化的定位，这条路线没有采用，因此把分流职责直接落在双 Nginx 上。

## 角色分工

| 组件 | 位置 | 职责 | 适合场景 |
| --- | --- | --- | --- |
| `reverse-nginx` | Docker `proxy` 网络 | 公网域名分流、路径控制、状态页只读暴露、后续负载均衡实验 | `*.yuuyan.top` |
| `Nginx Proxy Manager` | 局域网入口 | 内网服务快速反代、图形化维护、局域网域名入口 | `*.yuu.lan` |

## 公网链路

公网链路只处理需要外部访问的低风险服务：

```text
Internet
  -> Cloudflare DNS/CDN/Access
  -> Cloudflare Tunnel
  -> cloudflared container
  -> reverse-nginx
  -> public service
```

`reverse-nginx` 适合公网入口的原因：

- 配置文件可版本化，适合放入 Git 进行审计。
- 可以按域名和路径做精细限制。
- 可以统一维护 `proxy_set_header`、日志格式和安全响应头。
- 后续可以扩展 `upstream`，用于 Nginx 七层负载均衡实验。

示例：

- `blog.yuuyan.top` 转发到 Halo 前台。
- `status.yuuyan.top` 只允许访问 Uptime Kuma 状态页路径。
- 需要认证的入口必须先经过 Cloudflare Access。

## 内网链路

内网链路服务局域网设备：

```text
LAN client
  -> AdGuard Home DNS rewrite
  -> Nginx Proxy Manager
  -> internal service
```

Nginx Proxy Manager 适合内网入口的原因：

- 图形化维护成本低，新增服务快。
- 与 AdGuard Home 的 `*.yuu.lan` 内网域名搭配方便。
- 内网调试和日常维护不需要修改公网 Nginx 配置。
- 管理入口不直接出现在公网链路中。

## 为什么不只用一套 Nginx

如果公网和内网共用同一套入口，容易出现几个问题：

- 管理类服务误加入公网 server block。
- 公网域名和内网域名配置混杂，后期维护困难。
- 公开服务与内部运维服务共享同一风险边界。

双 Nginx 设计把公网与内网当成两条独立车道。它们可以转发到相同类型的后端服务，但入口、域名、访问来源和安全策略不同。相比基于传统 DNS 的分流方式，这种做法不需要额外维护一台 DNS 服务器，也更贴合轻量化目标。

## 配置组织建议

公网 `reverse-nginx` 建议按服务拆分：

```text
/etc/nginx/
├── nginx.conf
└── conf.d/
    ├── blog.yuuyan.top.conf
    ├── status.yuuyan.top.conf
    ├── home.yuuyan.top.conf
    └── common-proxy-headers.conf
```

内网 NPM 建议使用 `*.yuu.lan`：

```text
home.yuu.lan
kuma.yuu.lan
npm.yuu.lan
adguard.yuu.lan
```

## 保留两套入口的原因

这套拆分主要解决维护和风险边界问题：

- 公网入口的配置可以放入 Git，便于审查域名、路径和响应头。
- 内网入口用 NPM 维护，新增服务时不需要改公网 Nginx。
- 管理类服务默认不进入公网链路，降低误暴露概率。
- 后续做 upstream 或负载均衡实验时，只需要调整公网入口。
