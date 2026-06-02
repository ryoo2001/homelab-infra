# DDNS-Go + WireGuard 远程管理部署记录

本文记录一次从 Tailscale 迁移到 `DDNS-Go + WireGuard` 的实际部署过程。目标是远程管理 HomeLab，不对公网提供 Web 服务。

## 目标

- 远程设备在外网连接 WireGuard 后，可以访问家里服务器和内网管理服务。
- 公网只暴露 WireGuard UDP 端口。
- DDNS-Go 只负责动态更新域名解析，不作为公网服务暴露。
- Portainer、Nginx Proxy Manager、AdGuard Home、Uptime Kuma 后台、DDNS-Go 管理页都只允许 LAN 或 WireGuard 访问。

最终链路：

```text
Remote device
  -> vpn.yuuyan.top:51820/udp
  -> IPv6 firewall allow rule, or IPv4 router port forwarding as fallback
  -> HomeLab WireGuard
  -> SSH / Portainer / NPM / AdGuard / Uptime Kuma / DDNS-Go
```

公网暴露面：

```text
51820/udp
```

不暴露：

```text
80/tcp
443/tcp
9876/tcp     # DDNS-Go Web UI
51821/tcp    # wg-easy Web UI, not used in this deployment
Portainer / NPM / AdGuard / Uptime Kuma management ports
```

## 环境信息

本次实际环境：

| 项目 | 值 |
| --- | --- |
| HomeLab LAN IP | `192.168.31.178` |
| LAN 网段 | `192.168.31.0/24` |
| HomeLab 网卡 | `wlp2s0` |
| HomeLab IPv6 | `<homelab_public_ipv6>`，由 DDNS-Go 动态更新 |
| WireGuard IPv4 网段 | `10.7.0.0/24` |
| WireGuard IPv6 网段 | `fddd:2c4:2c4:2c4::/64` |
| WireGuard 服务端地址 | `10.7.0.1`, `fddd:2c4:2c4:2c4::1` |
| WireGuard 端口 | `51820/udp` |
| DDNS-Go 管理端口 | `9876/tcp` |
| DDNS 域名 | `vpn.yuuyan.top` |
| 系统防火墙 | `firewalld` |

路由器侧已确认：

- IPv4 使用 PPPoE。
- 路由器 WAN 口拿到公网 IPv4，不是 `10.0.0.0/8`、`100.64.0.0/10`、`172.16.0.0/12` 或 `192.168.0.0/16`。
- IPv6 为 Native，WireGuard 入口优先使用 DDNS-Go 的 `AAAA` 记录；IPv4 `A` 记录和 UDP 端口转发保留为 fallback。
- HomeLab 已在路由器 DHCP 中固定为 `192.168.31.178`。

## 前置判断

DDNS + WireGuard 入口依赖公网入站能力。IPv6 优先方案先确认：

```text
vpn.yuuyan.top AAAA == HomeLab 当前公网 IPv6
路由器 IPv6 防火墙允许 UDP 51820 到 HomeLab
```

IPv4 fallback 再确认路由器 WAN IP 是否为公网地址：

```text
路由器 WAN IPv4 == 公网查询 IPv4
```

如果路由器 WAN IP 属于下面网段，通常说明处于运营商 CGNAT 后面，DDNS + 家庭路由器端口转发无法直接入站：

```text
10.0.0.0/8
100.64.0.0/10
172.16.0.0/12
192.168.0.0/16
```

CGNAT 场景下，如果 IPv6 入站可用，WireGuard 仍可通过 IPv6 直连；如果 IPv6 入站也不可用，需要改用 VPS 中转，或者使用 Headscale / ZeroTier 这类带穿透或中继能力的方案。

## DDNS-Go 部署

DDNS-Go 使用 Docker 部署，建议通过 Portainer Stack 管理。这里使用 host 网络，便于 DDNS-Go 获取主机网络状态。

```yaml
services:
  ddns-go:
    image: jeessy/ddns-go:latest
    container_name: ddns-go
    restart: unless-stopped
    network_mode: host
    environment:
      - TZ=Asia/Shanghai
    volumes:
      - /data/compose/ddns-go:/root
    command:
      - -l
      - 0.0.0.0:9876
      - -f
      - "300"
```

部署后只在内网访问：

```text
http://192.168.31.178:9876
```

DDNS-Go 中配置：

| 项目 | 建议 |
| --- | --- |
| 记录类型 | `A` 和 `AAAA` |
| 主机记录 | `vpn.yuuyan.top` |
| 解析目标 | 当前家庭公网 IPv4 和 HomeLab 当前公网 IPv6 |
| 更新频率 | `300` 秒 |
| Token 权限 | 只允许修改指定域名记录 |

不要在路由器上转发 `9876/tcp`。

### DDNS-Go 防火墙问题

部署后曾出现内网访问不了 DDNS-Go 的问题。排查结果：

```bash
docker ps --filter name=ddns-go
docker logs ddns-go --tail=100
ss -lntp | grep 9876
curl -I http://127.0.0.1:9876
curl -I http://192.168.31.178:9876
```

当时现象：

```text
ddns-go 正常运行
监听 *:9876
127.0.0.1:9876 返回 307 /login
192.168.31.178:9876 返回 307 /login
其他内网设备无法访问
```

结论：Docker 和 DDNS-Go 正常，问题是主机防火墙拦截。

firewalld 放行 LAN 访问 DDNS-Go：

```bash
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="192.168.31.0/24" port protocol="tcp" port="9876" accept'
sudo firewall-cmd --reload
sudo firewall-cmd --list-all
```

## WireGuard 宿主机部署

本次最终没有把 WireGuard 部署到 Docker，而是直接部署在 HomeLab 宿主机上。这样路由、防火墙和排障更直接。

### 安装

RHEL / Rocky / Alma 系：

```bash
sudo dnf install -y wireguard-tools
```

Debian / Ubuntu 系：

```bash
sudo apt update
sudo apt install -y wireguard wireguard-tools
```

### FIPS 问题

本次部署中，WireGuard 服务端启动失败：

```text
ip link add wg0 type wireguard
Error: Unknown device type.
Unable to access interface: Protocol not supported
```

手动加载模块也失败：

```bash
modprobe wireguard
```

报错：

```text
modprobe: ERROR: could not insert 'wireguard': Operation not supported
```

进一步确认系统启用了 FIPS：

```bash
cat /proc/sys/crypto/fips_enabled
fips-mode-setup --check
```

WireGuard 使用的 ChaCha20-Poly1305、Curve25519、BLAKE2s 不适合 FIPS 模式环境。关闭 FIPS 后，WireGuard 可以正常运行。

关闭 FIPS 前需要确认没有合规要求，并确保有本地控制台或其他备用入口。关闭后检查：

```bash
cat /proc/sys/crypto/fips_enabled
```

期望结果：

```text
0
```

然后验证模块：

```bash
sudo modprobe wireguard
lsmod | grep wireguard
```

### 开启 IPv4 转发

```bash
echo 'net.ipv4.ip_forward=1' | sudo tee /etc/sysctl.d/99-wireguard.conf
sudo sysctl --system
sysctl net.ipv4.ip_forward
```

期望：

```text
net.ipv4.ip_forward = 1
```

### 生成密钥

在服务端执行：

```bash
sudo -i
cd /etc/wireguard
umask 077

wg genkey | tee server_private.key | wg pubkey > server_public.key
wg genkey | tee phone_private.key | wg pubkey > phone_public.key
wg genkey | tee laptop_private.key | wg pubkey > laptop_public.key
```

注意：

- 每台客户端一个独立 Peer。
- 不要共用客户端配置。
- 不要把 private key、peer 配置、二维码、DDNS Token 提交到 Git。

### 服务端配置

文件：

```text
/etc/wireguard/wg0.conf
```

示例：

```ini
[Interface]
Address = 10.7.0.1/24, fddd:2c4:2c4:2c4::1/64
ListenPort = 51820
PrivateKey = <server_private_key>

[Peer]
# phone
PublicKey = <phone_public_key>
AllowedIPs = 10.7.0.2/32, fddd:2c4:2c4:2c4::2/128

[Peer]
# laptop
PublicKey = <laptop_public_key>
AllowedIPs = 10.7.0.3/32, fddd:2c4:2c4:2c4::3/128
```

权限：

```bash
sudo chmod 600 /etc/wireguard/wg0.conf
```

如果出口网卡不是 `wlp2s0`，用下面命令确认：

```bash
ip route get 1.1.1.1
```

### firewalld 配置

放行 WireGuard 入站端口：

```bash
sudo firewall-cmd --permanent --add-port=51820/udp
```

允许 WireGuard 客户端访问 HomeLab 本机服务：

```bash
sudo firewall-cmd --permanent --zone=trusted --add-source=10.7.0.0/24
sudo firewall-cmd --permanent --zone=trusted --add-source=fddd:2c4:2c4:2c4::/64
```

允许 WireGuard 客户端通过服务端访问 LAN：

```bash
sudo firewall-cmd --direct --add-rule ipv4 nat POSTROUTING 0 -s 10.7.0.0/24 ! -d 10.7.0.0/24 -j MASQUERADE
sudo firewall-cmd --direct --add-rule ipv6 nat POSTROUTING 0 -s fddd:2c4:2c4:2c4::/64 ! -d fddd:2c4:2c4:2c4::/64 -j MASQUERADE
```

重新加载并检查：

```bash
sudo firewall-cmd --reload
sudo firewall-cmd --list-all
```

### 启动服务

`wg-quick@<name>` 中的 `<name>` 对应配置文件名：

```text
/etc/wireguard/wg0.conf      -> wg-quick@wg0
/etc/wireguard/homelab.conf  -> wg-quick@homelab
```

启动：

```bash
sudo systemctl enable --now wg-quick@wg0
sudo systemctl status wg-quick@wg0 -l --no-pager
sudo wg show
ip addr show wg0
```

## 路由器配置

IPv6 优先连接需要在路由器防火墙中允许入站：

```text
协议: UDP
目标 IPv6: <homelab_public_ipv6>
端口: 51820
```

IPv6 地址会随运营商前缀变化，DDNS-Go 会更新 `AAAA`；如果路由器防火墙只能绑定固定地址，需要在地址变化后同步调整规则，或改为按设备/MAC 放行。

IPv4 fallback 保留一条端口转发：

```text
协议: UDP
外部端口: 51820
内部 IP: 192.168.31.178
内部端口: 51820
```

不要转发：

```text
9876/tcp
22/tcp
80/tcp
443/tcp
Portainer / NPM / AdGuard / Uptime Kuma 管理端口
```

## 客户端配置

手机示例：

```ini
[Interface]
Address = 10.7.0.2/32, fddd:2c4:2c4:2c4::2/128
PrivateKey = <phone_private_key>
DNS = 192.168.31.178

[Peer]
PublicKey = <server_public_key>
Endpoint = vpn.yuuyan.top:51820
AllowedIPs = 10.7.0.0/24, fddd:2c4:2c4:2c4::/64, 192.168.31.0/24
PersistentKeepalive = 25
```

笔记本示例：

```ini
[Interface]
Address = 10.7.0.3/32, fddd:2c4:2c4:2c4::3/128
PrivateKey = <laptop_private_key>
DNS = 192.168.31.178

[Peer]
PublicKey = <server_public_key>
Endpoint = vpn.yuuyan.top:51820
AllowedIPs = 10.7.0.0/24, fddd:2c4:2c4:2c4::/64, 192.168.31.0/24
PersistentKeepalive = 25
```

`AllowedIPs` 使用分流模式：

```text
10.7.0.0/24, fddd:2c4:2c4:2c4::/64, 192.168.31.0/24
```

含义：

- 访问 WireGuard IPv4/IPv6 网段走 VPN。
- 访问家里 LAN 网段走 VPN。
- 其他公网流量仍走当前网络。

不要一开始使用：

```text
0.0.0.0/0, ::/0
```

除非明确需要全局流量回家。

## 代理和 DNS 注意事项

如果客户端同时使用 Clash / Mihomo，需确认 WireGuard Endpoint 域名不会被 fake-ip 或代理规则改写。排查方法见[运维指南 · WireGuard Endpoint 被 Clash / Mihomo fake-ip 影响](operations-guide.md#wireguard-endpoint-被-clash--mihomo-fake-ip-影响)。

## 验证流程

手机切蜂窝网络，不要连接家里 Wi-Fi。

客户端连接 WireGuard 后，在 HomeLab 上查看：

```bash
sudo wg show
```

期望看到：

```text
latest handshake: less than 1 minute ago
transfer: ...
```

客户端测试：

```text
ping 10.7.0.1
ping fddd:2c4:2c4:2c4::1
ping 192.168.31.178
ssh admin@192.168.31.178
打开 http://192.168.31.178:9876
```

如果 SSH 配置原来就是内网地址，可以不用改：

```sshconfig
Host homelab
    HostName 192.168.31.178
    User root
    Port 22
```

外出时先连接 WireGuard，再执行：

```bash
ssh homelab
```

## Tailscale 卸载

确认 WireGuard 外网访问稳定后，可以卸载 Tailscale。

先下线并停服务：

```bash
sudo tailscale down
sudo systemctl disable --now tailscaled
```

RHEL / Rocky / Alma / Fedora：

```bash
sudo dnf remove -y tailscale
sudo rm -rf /var/lib/tailscale
```

Debian / Ubuntu：

```bash
sudo apt purge -y tailscale
sudo rm -rf /var/lib/tailscale
sudo rm -f /etc/apt/sources.list.d/tailscale.list
sudo rm -f /usr/share/keyrings/tailscale-archive-keyring.gpg
sudo apt update
```

检查：

```bash
systemctl status tailscaled
ip link show tailscale0
which tailscale
```

## 常见问题

### 客户端没有握手

检查：

```bash
sudo wg show
sudo ss -lunp | grep 51820
sudo firewall-cmd --list-all
```

重点确认：

- DDNS 域名解析到真实家庭公网 IP。
- DDNS 域名 `A` 解析到真实家庭公网 IPv4，`AAAA` 解析到 HomeLab 当前公网 IPv6。
- 路由器 IPv6 防火墙已允许 UDP `51820` 到 HomeLab；IPv4 fallback 已转发 UDP `51820` 到 `192.168.31.178`。
- firewalld 已放行 `51820/udp`。
- 客户端 Endpoint 没有被 Clash / Mihomo fake-ip 解析成 `198.18.x.x`。

### 服务端启动失败：Protocol not supported

检查：

```bash
sudo modprobe wireguard
cat /proc/sys/crypto/fips_enabled
fips-mode-setup --check
```

如果 FIPS 开启，需要关闭 FIPS 或更换非 FIPS 系统后再运行 WireGuard。

### 能连 WireGuard，但访问不了 LAN

检查：

- 客户端 `AllowedIPs` 是否包含 `192.168.31.0/24` 和 `fddd:2c4:2c4:2c4::/64`。
- 服务端是否开启 `net.ipv4.ip_forward=1`。
- 服务端是否开启 `net.ipv6.conf.all.forwarding=1`。
- firewalld 是否开启 masquerade。
- `wg0.conf` 中 NAT 出口网卡是否为实际出口，例如 `wlp2s0`。

### 能访问 IP，不能访问内网域名

检查客户端 DNS：

```ini
DNS = 192.168.31.178
```

如果 AdGuard Home 不在 `192.168.31.178`，改成实际 AdGuard Home 地址。

## 安全建议

- 每台客户端一个独立 Peer。
- 丢失设备后立刻从 `wg0.conf` 删除对应 Peer，并重启 WireGuard。
- DDNS-Go Token 使用最小权限。
- 不把 DDNS-Go 配置目录、WireGuard 私钥、客户端配置、二维码提交到 Git。
- 路由器只转发 `51820/udp`。
- 管理服务只允许 LAN 和 WireGuard 网段访问。
- 定期检查：

```bash
sudo wg show
sudo firewall-cmd --list-all
docker logs ddns-go --tail=100
```

## 相关文档

- [WireGuard + DDNS-Go 设计](wireguard-ddnsgo-design.md)
- [运维指南](operations-guide.md)
- [README.md](../README.md)
