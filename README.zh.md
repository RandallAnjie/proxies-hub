# proxyhub

[English](README.md) · 中文

一个用**单一 Python 代码库**实现的拉取式(pull-through)镜像代理,替代
nginx + distribution-registry + ghproxy 一整套东西。基于 aiohttp 异步实现,
核心是一个**解耦的全速缓冲缓存**:未命中的对象由一个后台任务以服务器带宽从上游拉取、
写入不断增长的临时文件,任意数量的(可能很慢的)客户端从这个文件边写边读——
所以**慢客户端永远不会把上游连接拖到中途超时**。

## 代理了什么

| 域名(`domain = proxies.live`) | 后端 |
| --- | --- |
| `hub / ghcr / gcr / k8s / k8s-gcr / quay / mcr / elastic / nvcr / ollama` `.docker.<域名>` | Docker Registry v2 / OCI 拉取式(令牌鉴权,blob+manifest 按 digest 缓存并去重) |
| `github.<域名>` | GitHub:clone / raw / release、令牌别名、**私有 release 下载** |
| `npm / pypi / conda / torch / goproxy / hf / crates / maven / gmaven / gradle .<域名>` | 语言 & AI 包镜像(文件缓存,索引重验) |
| `apt.<域名>/<host>/<path>` | `apt` host-in-path —— 缓存 `.deb` / `.rpm` / `.apk`(Debian、EPEL/Rocky/Fedora、Alpine) |
| `cache.<域名>/<scheme>/<host>/<path>` | 通用直链文件缓存 |
| **`all.<域名>/<服务>/…`** | **单域名按路径分发** —— 上面所有服务走一个域名 |

## 核心特性

- **解耦缓冲缓存**(`cache.py`):回源速度由服务器决定而非客户端;并发读者共享同一次
  填充;按大小做 LRU 淘汰。
- **分片回源**(`base.py`):大 blob 按 128MB 的 `Range` 分片顺序拉取,**没有任何单个
  上游连接会开到被切断**(ghcr/CDN 对慢速长连接约 600 秒切断)。响应始终带已知的
  `Content-Length`(否则 docker 会无限重连)。分片途中遇到 `401` 会**刷新令牌并从当前
  偏移续传**(几个 GB 的层可能拉得比令牌寿命还长)。
- **内容寻址去重**:docker 的 **blob 和按 digest 的 manifest** 只用 sha256 做 key,
  所以跨仓库/跨源共享的同一层**只存一份**。按 tag 的 manifest 用 `If-None-Match` 重验
  (`304` → 走缓存)。
- **digest 完整性校验**:blob 边填边算 sha256,提交前与其 digest 比对——截断/损坏的
  回源绝不入缓存。
- **智能淘汰**:LRU 淘汰到 low-water 水位(不在边界抖动);保护窗口内用过的条目最后才
  淘汰;`pin` 正则的永不淘汰。残留的 `.part`/`.rv` 半成品在**启动时**和**每 10 分钟**清扫。
- **条件重验**(`webcache.py`):又大又不常变的索引(conda repodata、npm 元数据、cargo
  index)带 ETag 缓存,`304` 时直接给缓存——既新鲜,又不重复下载。
- **GitHub**:全连接类型(git clone smart-HTTP、raw、归档、release 资产);`?token=别名`
  在服务端换成真实 PAT;私有 release 翻译成 API 资产端点,普通 URL 也能下。

## 统一入口 all

`all.<域名>` 按**第一段路径**分发,不用记一堆子域名:

```bash
docker pull all.proxies.live/hub/library/nginx      # -> /v2/hub/... , hub 即选择器
pip install -i https://all.proxies.live/pypi/index/ requests
git clone https://all.proxies.live/github/github.com/<用户>/<仓库>
# cargo index = "sparse+https://all.proxies.live/crates/"
```

docker 天然可用:`docker pull all.<域名>/hub/x` 会产生 `/v2/hub/…`。**私有** docker
源(配了凭据的)**不在 all 上暴露**——它们保留在各自带 basic-auth 的子域名,所以 `all`
可以免登录。

## 面板与文档

- `https://dash.<域名>/` —— **监控页**:近 10 分钟命中率、按小时命中率折线、缓存占用、
  每服务分布,以及端到端**域名探测**(在浏览器里做,浏览器就是真实客户端,反映真实公网可用性)。
- `https://dash.<域名>/docs` —— **用法文档**。浏览器给 HTML(探测驱动,只列出你实际可达的
  域名,每个服务给专属 + `all` 两种形式)。**`curl`/`wget`/空 UA 给 Markdown**。

```bash
curl dash.proxies.live/docs        # 终端里直接看 markdown 文档
```

- `/status`(JSON)与 `/metrics`(Prometheus):运行时长、请求数、缓存命中/未命中/字节/
  文件数、校验失败、重验次数、每服务标签。

## 运行

开箱即用——镜像内置默认配置,只需给个域名:

```bash
docker run -p 8080:8080 -v cache:/var/cache/proxyhub \
  -e PROXYHUB_DOMAIN=example.com ranjie/proxies
```

挂载你自己的 `/app/config.yaml` 改上游/凭据;标量项可用环境变量覆盖,无需改文件:

| 环境变量 | 覆盖 | 默认 |
| --- | --- | --- |
| `PROXYHUB_DOMAIN` | 路由 + 面板的域名后缀 | `example.com` |
| `PROXYHUB_CACHE_MAX` | 缓存上限(如 `250g`) | `50g` |
| `PROXYHUB_HOST` / `PROXYHUB_PORT` | 监听地址 | `0.0.0.0:8080` |
| `PROXYHUB_CACHE_DIR` | 缓存目录 | `/var/cache/proxyhub` |

源码运行:`pip install -r requirements.txt && PYTHONPATH=src python -m proxyhub -c config.yaml`
(`${GHCR_PAT}` / `${GITHUB_PAT}` 等密钥从环境变量读)。

它只跑**明文 HTTP** `:8080`,**不管 TLS**——请在前面放你自己的反代(Caddy/nginx/Traefik)
加证书。路由按 `Host` 头。页脚(项目地址 + Powered By Randall)固定,不可配置。

## 客户端配置

```bash
docker pull hub.docker.proxies.live/library/nginx
docker login ghcr.docker.proxies.live && docker pull ghcr.docker.proxies.live/<o>/<i>   # 私有
ollama pull ollama.docker.proxies.live/library/llama3
npm config set registry https://npm.proxies.live
pip config set global.index-url https://pypi.proxies.live/index/
conda config --set channel_alias https://conda.proxies.live
pip install torch --index-url https://torch.proxies.live/whl/cu121
go env -w GOPROXY=https://goproxy.proxies.live,direct
export HF_ENDPOINT=https://hf.proxies.live
# Rust ~/.cargo/config.toml -> index = "sparse+https://crates.proxies.live/"
# Maven settings.xml <mirror><url>https://maven.proxies.live</url>
# Alpine /etc/apk/repositories -> https://apk.proxies.live/alpine/v3.19/main
# apt / rpm:在上游域名前加 https://apt.proxies.live/
curl https://cache.proxies.live/https/host/path/file.tgz
```

## 代码结构

```
src/proxyhub/
  cache.py            解耦缓冲缓存:去重、完整性、LRU、重验、清扫
  config.py           YAML 配置(+ ${ENV} 与 PROXYHUB_* 覆盖)
  upstream.py         共享 aiohttp 会话
  server.py           Host 路由、面板/文档页、/status、/metrics
  proxies/
    base.py           分片/重定向回源、响应封装
    docker.py         Docker Registry v2 / OCI + bearer 鉴权 + manifest 缓存
    github.py         github 代理、令牌别名、私有 release 翻译
    webcache.py       包索引镜像 + 通用前缀缓存
    apt.py            apt/rpm/apk host-in-path 镜像
    pypi.py           PyPI simple 索引重写 + 文件缓存
    crates.py         Rust cargo sparse registry
    all.py            单域名按路径分发
  static/             monitor.html + docs.html(面板模板)
tests/                缓存、分片回源+令牌续传、按小时/滚动命中率
```

CI 跑 `ruff` + `pytest`;镜像发布到 Docker Hub(`ranjie/proxies`,原生构建 amd64 + arm64)。

## 实测:超过 10 分钟的拉取

本项目要解决的最初问题:一个大层的传输超过上游约 600 秒的切断窗口,在 docker 侧表现为
`unexpected EOF`。用一个 12.8GB(解压 39.5GB、31 层)的**私有 ghcr** 镜像、经慢速
ghcr→服务器链路做端到端实测:

- 完整 `docker pull` 成功;镜像 digest 与上游 index 完全一致。
- 冷缓存并发拉取最大的三层(3.18 / 2.91 / 2.63 GB)——**单个客户端连接持续 13.8 分钟**、
  返回 `200` 且字节精确;分片回源让每个上游连接都短命,没有一个碰到切断窗口。
- ghcr 的 CDN 确实支持 `Range`(任意偏移实测 `206`);断点续传 `Range: bytes=N-` 以
  `206` + 亚 100ms 首字节返回;缓存层热读以约 180 MB/s 从磁盘流出。
