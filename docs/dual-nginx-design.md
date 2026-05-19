# 为什么不用传统 DNS 分流，而是用两个 Nginx + proxy 网络

本项目没有采用“单套 DNS 视图 + 内外网分流”的做法。公开入口和内网入口被拆成两个 Nginx，后端服务再通过 Docker `proxy` 网络转发。

## 先看结论

传统 DNS 分流当然能做。问题是维护成本会集中到 DNS 层，尤其是下面几件事：

- 要维护分视图解析。
- 要同步局域网重写和公开解析。
- 要处理不同客户端、不同网络、不同缓存带来的解析差异。
- 要把“访问边界”藏在 DNS 规则里，而不是显式放在入口层。

这里把分流责任放到入口层：

- `reverse-nginx` 只处理公网链路。
- `Nginx Proxy Manager` 只处理内网链路。
- 后端服务通过 Docker `proxy` 网络被两个入口统一访问。

DNS 只负责把名字解析到入口，不再决定请求走哪条链路。

## 两条链路怎么走

### 公网链路

```text
Internet
  -> Cloudflare DNS/CDN/Access
  -> Cloudflare Tunnel
  -> cloudflared container
  -> reverse-nginx
  -> public service
```

这条链路只放公开内容，比如博客前台和公开状态页。`reverse-nginx` 按域名、路径和响应策略做限制，不处理内网服务，也不承载管理面板。

### 内网链路

```text
LAN client
  -> AdGuard Home DNS rewrite
  -> Nginx Proxy Manager
  -> internal service
```

这条链路服务局域网设备，比如 Homepage、Kuma 后台和 AdGuard 管理页。AdGuard Home 只做名字解析和局域网入口落点，反代和站点维护交给 NPM。

## 为什么不用传统 DNS 分流

如果用传统方案，常见做法是：

- 公网域名走一套解析。
- 局域网域名走另一套解析。
- 同一个服务在不同网络里可能要返回不同目标。

DNS 一旦变成“分流器”，就会同时背上解析、策略、缓存和变更同步。排查时会遇到这些问题：

- 客户端缓存的结果可能和预期不一致。
- 内外网切换时，解析目标可能不一致。
- 公开入口和局域网入口的变更要同步到 DNS 规则。
- 一旦 DNS 规则出错，故障面会直接扩大到全网解析。

本仓库把这些复杂性从 DNS 挪走：

- DNS 只告诉客户端去哪个入口。
- 入口层决定这条请求属于公开链路还是内网链路。
- 后端服务通过 `proxy` 网络被统一转发。

入口在哪里，问题就从哪里查。

## 为什么是两个 Nginx

两个 Nginx 是为了把职责拆开。

- `reverse-nginx` 面向公网，适合版本化配置、路径控制、只读暴露和安全响应头统一管理。
- `Nginx Proxy Manager` 面向内网，适合图形化维护、局域网域名管理和日常增删服务。

两者分开后，公开入口和内网入口可以各管各的：

- 公网 Nginx 不需要知道内网管理面板的细节。
- NPM 不需要承担公开暴露策略。
- 新服务接入时，只需要判断它应该进入哪条链路。

## `proxy` 网络在这里做什么

Docker `proxy` 网络的作用很单纯：给入口层提供一个稳定的后端可达面。

- 只有确实需要被入口访问的服务才加入 `proxy` 网络。
- `reverse-nginx` 通过容器名访问公网后端。
- `Nginx Proxy Manager` 通过容器名访问内网后端。

这样做有两个直接好处：

1. 宿主机端口映射可以减少。
2. 服务是否对外暴露变成显式决策，而不是默认开放。

## 配置组织

公网入口的配置按服务拆分，便于审计和回滚：

```text
/etc/nginx/
└── conf.d/
    ├── blog.yuuyan.top.conf
    ├── status.yuuyan.top.conf
    └── home.yuuyan.top.conf
```

内网入口则围绕 `*.yuu.lan` 组织：

```text
home.yuu.lan
kuma.yuu.lan
npm.yuu.lan
adguard.yuu.lan
```

这种组织方式主要是为了减少串线：

- DNS 不做分流决策。
- 入口 Nginx 只管自己的访问域。
- 后端服务只接收被允许的流量。

## 运维约束

这套方案有几条硬约束：

- 公开入口和内网入口必须分开维护。
- 只有需要公开的服务才加入 `proxy` 网络。
- 管理面板默认不进入公网链路。
- 公开状态页只暴露状态内容，不暴露控制面。
- 变更入口配置时，要同时检查 DNS 记录、Nginx 配置和 Docker 网络。

它不会让配置消失，只是把复杂度放到更容易检查的位置。

## 相关文档

- [docs/architecture.md](architecture.md)
- [docs/docker-network-isolation.md](docker-network-isolation.md)
