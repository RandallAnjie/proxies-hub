import { catalogItems, type CatalogItem } from "./catalog";
import { isMarkdownUa } from "./docs";

type GroupId = "docker" | "index" | "sys";

type Meta = {
  title: string;
  blurb: string;
  group: GroupId;
  keys: string;
};

const GROUPS: { id: GroupId; no: string; title: string; hint: string }[] = [
  { id: "docker", no: "01", title: "Docker / OCI", hint: "public only" },
  { id: "index", no: "02", title: "语言与包索引", hint: "/<service>/…" },
  { id: "sys", no: "03", title: "Git · 系统 · 缓存", hint: "host-in-path" },
];

const META: Record<string, Meta> = {
  hub: { title: "Docker Hub", blurb: "OCI 拉取", group: "docker", keys: "docker nginx oci hub" },
  ghcr: { title: "GHCR", blurb: "GitHub 容器", group: "docker", keys: "docker ghcr github" },
  gcr: { title: "GCR", blurb: "Google 容器", group: "docker", keys: "docker gcr google" },
  "k8s-gcr": { title: "k8s.gcr.io", blurb: "K8s 旧源", group: "docker", keys: "docker kubernetes k8s" },
  k8s: { title: "registry.k8s.io", blurb: "K8s 官方", group: "docker", keys: "docker kubernetes pause" },
  quay: { title: "Quay", blurb: "Red Hat", group: "docker", keys: "docker quay" },
  mcr: { title: "MCR", blurb: "Microsoft", group: "docker", keys: "docker microsoft mcr" },
  elastic: { title: "Elastic", blurb: "Elastic 镜像", group: "docker", keys: "docker elastic" },
  nvcr: { title: "NGC", blurb: "NVIDIA", group: "docker", keys: "docker nvidia nvcr" },
  ollama: { title: "Ollama", blurb: "本地模型", group: "docker", keys: "ollama llama llm" },
  npm: { title: "npm", blurb: "Node 包", group: "index", keys: "npm node javascript" },
  pypi: { title: "PyPI", blurb: "pip / uv", group: "index", keys: "pip uv python pypi" },
  conda: { title: "Conda", blurb: "频道别名", group: "index", keys: "conda anaconda" },
  torch: { title: "PyTorch", blurb: "whl 索引", group: "index", keys: "torch pytorch cuda" },
  goproxy: { title: "Go modules", blurb: "GOPROXY", group: "index", keys: "go goproxy modules" },
  hf: { title: "Hugging Face", blurb: "模型 / 数据集", group: "index", keys: "huggingface hf 模型" },
  crates: { title: "crates.io", blurb: "cargo sparse", group: "index", keys: "cargo rust crates sparse" },
  maven: { title: "Maven Central", blurb: "settings.xml", group: "index", keys: "maven java gradle" },
  gmaven: { title: "Google Maven", blurb: "Android", group: "index", keys: "gmaven android google" },
  gradle: { title: "Gradle 插件", blurb: "plugin portal", group: "index", keys: "gradle plugin" },
  apk: { title: "Alpine APK", blurb: "repositories", group: "sys", keys: "alpine apk" },
  github: { title: "GitHub", blurb: "clone / raw / release", group: "sys", keys: "git clone raw release" },
  apt: { title: "apt / rpm", blurb: "host-in-path", group: "sys", keys: "apt deb rpm debian ubuntu fedora epel" },
  cache: { title: "通用缓存", blurb: "任意直链", group: "sys", keys: "cache curl generic" },
};

export function wantsLandingHtml(request: Request): boolean {
  const ua = request.headers.get("User-Agent") || "";
  if (isMarkdownUa(ua)) return false;
  const accept = request.headers.get("Accept") || "";
  return /\btext\/html\b/i.test(accept);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function brandHtml(host: string): string {
  const i = host.indexOf(".");
  if (i === -1) return escapeHtml(host);
  return `${escapeHtml(host.slice(0, i))}<span class="dot">.</span>${escapeHtml(host.slice(i + 1))}`;
}

function metaFor(item: CatalogItem): Meta {
  return (
    META[item.id] ?? {
      title: item.id,
      blurb: item.family === "docker" ? "OCI" : "镜像",
      group: item.family === "docker" ? "docker" : "index",
      keys: item.id,
    }
  );
}

export function snippetFor(item: CatalogItem, host: string): string {
  switch (item.id) {
    case "hub":
      return `docker pull ${host}/hub/library/nginx`;
    case "ollama":
      return `ollama pull ${host}/ollama/library/llama3`;
    case "ghcr":
      return `docker pull ${host}/ghcr/<owner>/<image>`;
    case "pypi":
      return [
        `pip install -i https://${host}/pypi/index/ requests`,
        `uv pip install --index-url https://${host}/pypi/index/ requests`,
      ].join("\n");
    case "npm":
      return `npm config set registry https://${host}/npm`;
    case "conda":
      return `conda config --set channel_alias https://${host}/conda`;
    case "torch":
      return `pip install torch --index-url https://${host}/torch/whl/cu121`;
    case "goproxy":
      return `go env -w GOPROXY=https://${host}/goproxy,direct`;
    case "hf":
      return `export HF_ENDPOINT=https://${host}/hf`;
    case "crates":
      return [
        "# ~/.cargo/config.toml",
        "[source.crates-io]",
        'replace-with = "mirror"',
        "[registries.mirror]",
        `index = "sparse+https://${host}/crates/"`,
      ].join("\n");
    case "maven":
      return [
        "# ~/.m2/settings.xml",
        `<mirror><id>proxyhub</id><url>https://${host}/maven</url><mirrorOf>central</mirrorOf></mirror>`,
      ].join("\n");
    case "gmaven":
      return `maven { url "https://${host}/gmaven" }`;
    case "gradle":
      return [
        "// settings.gradle",
        "pluginManagement {",
        `  repositories { maven { url "https://${host}/gradle" } }`,
        "}",
      ].join("\n");
    case "apk":
      return [
        "# /etc/apk/repositories",
        `https://${host}/apk/alpine/v3.19/main`,
        `https://${host}/apk/alpine/v3.19/community`,
      ].join("\n");
    case "apt":
      return [
        `deb https://${host}/apt/archive.ubuntu.com/ubuntu jammy main`,
        `# RPM: baseurl=https://${host}/apt/dl.fedoraproject.org/pub/epel/9/...`,
      ].join("\n");
    case "cache":
      return `curl https://${host}/cache/https/<host>/<path>`;
    case "github":
      return [
        `git clone https://${host}/github/github.com/<u>/<r>`,
        `# raw:     https://${host}/github/raw.githubusercontent.com/<u>/<r>/<ref>/<path>`,
        `# release: https://${host}/github/github.com/<u>/<r>/releases/download/<tag>/<file>`,
      ].join("\n");
    default:
      if (item.family === "docker") return `docker pull ${host}/${item.id}/<image>`;
      return `curl https://${host}${item.prefix}/`;
  }
}

function cardHtml(item: CatalogItem, host: string): string {
  const meta = metaFor(item);
  const snippet = snippetFor(item, host);
  const q = [item.id, item.prefix, item.upstream, meta.title, meta.blurb, meta.keys]
    .join(" ")
    .toLowerCase();
  return `<article class="card" data-q="${escapeHtml(q)}" data-id="${escapeHtml(item.id)}">
  <div class="cardh">
    <h3>${escapeHtml(meta.title)}</h3>
    <span class="pfx">${escapeHtml(item.prefix)}</span>
  </div>
  <p class="up" title="${escapeHtml(item.upstream)}">${escapeHtml(item.upstream)}</p>
  <div class="codewrap"><pre><code>${escapeHtml(snippet)}</code></pre><button class="cp" type="button">复制</button></div>
</article>`;
}

export function landingHtml(host: string): string {
  const items = catalogItems();
  const sections = GROUPS.map((g) => {
    const cards = items.filter((it) => metaFor(it).group === g.id).map((it) => cardHtml(it, host));
    if (!cards.length) return "";
    return `<section class="reveal" data-group="${g.id}">
  <div class="sechead"><span class="no">${g.no}</span><h2>${escapeHtml(g.title)}</h2><span class="hint">${escapeHtml(g.hint)}</span></div>
  <div class="cards">${cards.join("")}</div>
</section>`;
  }).join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(host)} — proxyhub</title>
<style>
:root{
  --bg:#0d0e11;--panel:#141519;--ink:#e9e6e1;--dim:#8b8a86;
  --line:#26272d;--accent:#ff5b35;--accent-soft:#ff5b3522;
  --ok:#39c07a;--mono:ui-monospace,"SF Mono-Regular",Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
  color-scheme:dark;
}
@media (prefers-color-scheme:light){
  :root{
    --bg:#faf7f2;--panel:#fffefb;--ink:#1b1a17;--dim:#6b6a64;
    --line:#e6e1d8;--accent:#e8401a;--accent-soft:#e8401a18;
    color-scheme:light;
  }
}
html[data-theme="dark"]{
  --bg:#0d0e11;--panel:#141519;--ink:#e9e6e1;--dim:#8b8a86;
  --line:#26272d;--accent:#ff5b35;--accent-soft:#ff5b3522;color-scheme:dark;
}
html[data-theme="light"]{
  --bg:#faf7f2;--panel:#fffefb;--ink:#1b1a17;--dim:#6b6a64;
  --line:#e6e1d8;--accent:#e8401a;--accent-soft:#e8401a18;color-scheme:light;
}
*{box-sizing:border-box}
body{
  margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);
  line-height:1.6;-webkit-font-smoothing:antialiased;
  background-image:radial-gradient(var(--line) 1px,transparent 1px);
  background-size:22px 22px;
}
.wrap{max-width:920px;margin:0 auto;padding:0 22px}
header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:48px 0 8px}
h1{font-family:var(--mono);font-size:clamp(22px,4.6vw,36px);margin:0;letter-spacing:-.5px;word-break:break-all}
h1 .dot{color:var(--accent)}
.tag{color:var(--dim);font-family:var(--mono);font-size:13px;margin:8px 0 0}
.hdr{display:flex;align-items:center;gap:10px;flex:0 0 auto}
.docs{font-family:var(--mono);font-size:12px;color:var(--accent);text-decoration:none;border:1px solid var(--line);
  background:var(--panel);padding:8px 10px;border-radius:8px}
.docs:hover{border-color:var(--accent)}
.toggle{cursor:pointer;border:1px solid var(--line);background:var(--panel);color:var(--ink);
  width:40px;height:40px;border-radius:50%;font-size:18px;line-height:1;
  transition:transform .35s ease,border-color .2s;display:grid;place-items:center}
.toggle:hover{transform:rotate(35deg);border-color:var(--accent)}
.lead{color:var(--dim);font-size:14.5px;max-width:72ch;margin:14px 0 22px;border-left:2px solid var(--accent);padding-left:14px}
.lead code,.card .pfx{font-family:var(--mono);font-size:12.5px}
.status{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 18px}
.status .lab{font-family:var(--mono);font-size:11px;color:var(--dim)}
.pill{font-family:var(--mono);font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:20px;
  padding:3px 9px;display:flex;align-items:center;gap:6px}
.pill::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--dim)}
.pill.up::before{background:var(--ok);box-shadow:0 0 0 3px #39c07a22}
.pill.down{color:var(--accent)}.pill.down::before{background:var(--accent)}
.toolbar{display:flex;align-items:center;gap:12px;margin:0 0 22px}
#q{flex:1;min-width:0;border:1px solid var(--line);background:var(--panel);color:var(--ink);
  font-family:var(--sans);font-size:14px;padding:10px 12px;border-radius:8px;outline:none}
#q:focus{border-color:var(--accent)}
#count{font-family:var(--mono);font-size:12px;color:var(--dim);white-space:nowrap}
section{margin:0 0 28px}
.sechead{display:flex;align-items:center;gap:12px;margin:0 0 12px}
.sechead .no{font-family:var(--mono);font-size:12px;color:var(--accent);border:1px solid var(--accent-soft);
  background:var(--accent-soft);padding:2px 7px;border-radius:4px}
.sechead h2{font-size:17px;margin:0;font-weight:600}
.sechead .hint{color:var(--dim);font-size:12.5px;font-family:var(--mono);margin-left:auto}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 12px 10px;min-width:0}
.cardh{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.cardh h3{margin:0;font-size:15px}
.card .pfx{color:var(--accent)}
.card .up{margin:4px 0 8px;color:var(--dim);font-family:var(--mono);font-size:11.5px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.codewrap{position:relative}
pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;padding-right:52px;
  overflow:auto;font-family:var(--mono);font-size:12px;margin:0;line-height:1.45}
.cp{position:absolute;top:6px;right:6px;cursor:pointer;border:1px solid var(--line);
  background:var(--panel);color:var(--dim);font-family:var(--mono);font-size:11px;padding:3px 8px;border-radius:5px}
.cp:hover{color:var(--accent);border-color:var(--accent)}
.cp.ok{color:var(--ok);border-color:var(--ok)}
#empty{display:none;color:var(--dim);font-family:var(--mono);font-size:13px;margin:8px 0 24px}
footer{border-top:1px solid var(--line);margin-top:18px;padding:24px 0 50px;color:var(--dim);
  font-family:var(--mono);font-size:12px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}
footer .blink{color:var(--accent)}
a.dom{font-family:var(--mono);color:var(--accent);text-decoration:none}
.reveal{opacity:0;transform:translateY(8px);animation:rise .5s ease forwards}
@keyframes rise{to{opacity:1;transform:none}}
@media (max-width:640px){
  header{padding-top:28px;flex-wrap:wrap}
  .cards{grid-template-columns:1fr}
  .sechead{flex-wrap:wrap}
  .toolbar .lab{display:none}
}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>${brandHtml(host)}</h1>
      <p class="tag">A single, hackable pull-through mirror proxy</p>
    </div>
    <div class="hdr">
      <a class="docs" href="/docs">/docs</a>
      <button class="toggle" id="t" title="切换主题" aria-label="切换主题">◐</button>
    </div>
  </header>
  <p class="lead">单一域名、按路径分发的<strong>拉取式镜像代理</strong>。Docker / OCI 走 <code>/v2/&lt;registry&gt;/…</code>；GitHub、PyPI、npm、crates 等走 <code>/&lt;service&gt;/…</code>。私有 Docker 源不在此暴露。完整用法见 <a class="dom" href="/docs">/docs</a>（curl 返回 Markdown）。</p>
  <div class="status" aria-live="polite">
    <span class="lab">节点</span>
    <span class="pill" data-probe="/v2/" data-hdr="docker-distribution-api-version">docker /v2</span>
    <span class="pill" data-probe="/pypi/index/pip/">pypi index</span>
  </div>
  <div class="toolbar">
    <label class="lab" for="q">筛选</label>
    <input id="q" type="search" placeholder="筛选服务、路径或上游…" autocomplete="off">
    <span id="count"></span>
  </div>
  ${sections}
  <p id="empty">没有匹配的服务</p>
  <footer>
    <span><a class="dom" href="https://github.com/RandallAnjie/proxies-hub" target="_blank" rel="noopener">github.com/RandallAnjie/proxies-hub</a></span>
    <span>Powered By <span class="blink">Randall</span></span>
  </footer>
</div>
<script>
(function(){
  var root=document.documentElement,k='proxies-theme';
  var saved=localStorage.getItem(k);
  if(saved) root.dataset.theme=saved;
  document.getElementById('t').onclick=function(){
    var cur=root.dataset.theme;
    if(!cur) cur=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';
    var n=cur==='dark'?'light':'dark';
    root.dataset.theme=n; localStorage.setItem(k,n);
  };
  function copyText(t){
    if(navigator.clipboard&&navigator.clipboard.writeText) return navigator.clipboard.writeText(t);
    var ta=document.createElement('textarea'); ta.value=t; document.body.appendChild(ta); ta.select();
    try{document.execCommand('copy');}finally{ta.remove();}
    return Promise.resolve();
  }
  document.querySelectorAll('.cp').forEach(function(b){
    b.onclick=function(){
      var code=b.parentElement.querySelector('code').innerText;
      copyText(code).then(function(){
        b.textContent='已复制'; b.classList.add('ok');
        setTimeout(function(){b.textContent='复制'; b.classList.remove('ok');},1400);
      });
    };
  });
  var box=document.getElementById('q'), count=document.getElementById('count'), empty=document.getElementById('empty');
  var cards=[].slice.call(document.querySelectorAll('[data-q]'));
  function apply(){
    var q=box.value.trim().toLowerCase(), n=0;
    cards.forEach(function(el){
      var show=!q||el.getAttribute('data-q').indexOf(q)>=0;
      el.hidden=!show; if(show) n++;
    });
    document.querySelectorAll('[data-group]').forEach(function(g){
      var any=false;
      g.querySelectorAll('[data-q]').forEach(function(el){ if(!el.hidden) any=true; });
      g.hidden=!any;
    });
    count.textContent=n+' / '+cards.length;
    empty.style.display=n?'none':'block';
  }
  box.addEventListener('input',apply); apply();
  document.querySelectorAll('.reveal').forEach(function(el,i){ el.style.animationDelay=(i*0.06)+'s'; });
  document.querySelectorAll('.pill[data-probe]').forEach(function(el){
    var path=el.getAttribute('data-probe'), need=el.getAttribute('data-hdr');
    var ctrl=new AbortController();
    var t=setTimeout(function(){ctrl.abort();},2500);
    fetch(path,{method:'GET',signal:ctrl.signal,headers:{Accept:'text/html,application/json;q=0.8,*/*;q=0.5'}})
      .then(function(r){
        var ok=r.ok&&(!need||r.headers.get(need));
        el.classList.add(ok?'up':'down');
      })
      .catch(function(){ el.classList.add('down'); })
      .then(function(){ clearTimeout(t); });
  });
})();
</script>
</body>
</html>`;
}
