import { publicDockerRegistries } from "./route";

export function docsMarkdown(host: string): string {
  const h = host;
  const regs = publicDockerRegistries().join(", ");
  return `# proxyhub — all-in-one

Single host, path-dispatched. Credentials are never stored on this host.

## Docker / OCI

\`\`\`bash
docker pull ${h}/hub/library/nginx
docker pull ${h}/ghcr/<owner>/<image>
ollama pull ${h}/ollama/library/llama3

# any third-party registry (multi-level repos and digests work)
docker pull ${h}/r/ghcr.io/<owner>/<image>
docker pull ${h}/r/release.cloudreve.org/cloudreve/pro:latest

# private / credentialed — docker login, then pull. Nothing is stored here.
docker login ${h}
docker pull ${h}/r/<registry-host>/<repo>:<tag>
# the same login works for a private image on a fixed prefix:
docker pull ${h}/ghcr/<owner>/<private-image>
\`\`\`

Public registries: ${regs}

Path form: \`/v2/<registry>/<repo>/...\`  (docker puts \`<registry>\` after \`/v2/\`).

Generic form: \`/v2/r/<registry-host>[:port]/<repo>/...\` → \`https://<registry-host>/v2/<repo>/...\`.

Docker stores **one credential per registry host**. Login to \`${h}\` is shared by every \`/v2/...\` and \`/v2/r/...\` pull through this hostname.

Authenticated requests (a client \`Authorization\` header, or a token obtained with those credentials) are **never cached**, including blobs. Anonymous public content keeps the usual digest/tag cache rules.

## GitHub

\`\`\`bash
git clone https://${h}/github/github.com/<u>/<r>
# raw:     https://${h}/github/raw.githubusercontent.com/<u>/<r>/<ref>/<path>
# archive: https://${h}/github/github.com/<u>/<r>/archive/refs/heads/main.tar.gz
# optional ?token=team  (alias → GITHUB_PAT) or ?token=<pat>
\`\`\`

## PyPI

\`\`\`bash
pip install -i https://${h}/pypi/index/ requests
\`\`\`

## Rust (cargo sparse)

\`\`\`toml
# ~/.cargo/config.toml
[source.crates-io]
replace-with = "mirror"
[registries.mirror]
index = "sparse+https://${h}/crates/"
\`\`\`

## Language / package indexes

\`\`\`bash
npm config set registry https://${h}/npm
conda config --set channel_alias https://${h}/conda
pip install torch --index-url https://${h}/torch/whl/cu121
go env -w GOPROXY=https://${h}/goproxy,direct
export HF_ENDPOINT=https://${h}/hf
# maven:  https://${h}/maven
# gmaven: https://${h}/gmaven
# gradle: https://${h}/gradle
# alpine: https://${h}/apk/alpine/v3.19/main
\`\`\`

## apt / rpm (host-in-path)

\`\`\`bash
deb https://${h}/apt/archive.ubuntu.com/ubuntu jammy main
# RPM: baseurl=https://${h}/apt/dl.fedoraproject.org/pub/epel/9/...
\`\`\`

## Generic cache

\`\`\`bash
curl https://${h}/cache/https/<host>/<path>
\`\`\`

---
Powered By Randall · github.com/RandallAnjie/proxies-hub
`;
}

export function docsHtml(host: string): string {
  const md = docsMarkdown(host);
  const brand = host.includes(".")
    ? host.replace(".", '<span class="dot">.</span>')
    : host;
  const sections = [
    {
      no: "01",
      title: "Docker / OCI",
      hint: "/v2/<reg> · /v2/r/…",
      code: `docker pull ${host}/hub/library/nginx\ndocker pull ${host}/ghcr/<owner>/<image>\ndocker pull ${host}/r/ghcr.io/<owner>/<image>\ndocker login ${host}\ndocker pull ${host}/r/<registry-host>/<repo>:<tag>`,
    },
    {
      no: "02",
      title: "GitHub",
      hint: "clone / raw / release",
      code: `git clone https://${host}/github/github.com/<u>/<r>`,
    },
    {
      no: "03",
      title: "PyPI / cargo / npm",
      hint: "indexes rewritten to this host",
      code: `pip install -i https://${host}/pypi/index/ requests\n# cargo: sparse+https://${host}/crates/\nnpm config set registry https://${host}/npm`,
    },
    {
      no: "04",
      title: "Other indexes",
      hint: "path prefix = service",
      code: `conda config --set channel_alias https://${host}/conda\npip install torch --index-url https://${host}/torch/whl/cu121\ngo env -w GOPROXY=https://${host}/goproxy,direct\nexport HF_ENDPOINT=https://${host}/hf\n# maven / gmaven / gradle / apk\n#   https://${host}/maven\n#   https://${host}/apk/alpine/v3.19/main`,
    },
    {
      no: "05",
      title: "apt / generic",
      hint: "host-in-path",
      code: `deb https://${host}/apt/archive.ubuntu.com/ubuntu jammy main\ncurl https://${host}/cache/https/<host>/<path>`,
    },
  ];
  const body = sections
    .map(
      (s) => `<section class="reveal">
  <div class="sechead"><span class="no">${s.no}</span><h2>${s.title}</h2><span class="hint">${s.hint}</span></div>
  <div class="codewrap"><pre><code>${escapeHtml(s.code)}</code></pre><button class="cp" type="button">copy</button></div>
</section>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(host)} — proxyhub</title>
<style>
  :root{
    --bg:#0d0e11; --panel:#141519; --ink:#e9e6e1; --dim:#8b8a86;
    --line:#26272d; --accent:#ff5b35; --accent-soft:#ff5b3522;
    --mono:ui-monospace,"SF Mono-Regular","JetBrains Mono",Menlo,Consolas,monospace;
    --sans:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
  }
  [data-theme="light"]{
    --bg:#faf7f2; --panel:#fffefb; --ink:#1b1a17; --dim:#6b6a64;
    --line:#e6e1d8; --accent:#e8401a; --accent-soft:#e8401a18;
  }
  *{box-sizing:border-box}
  body{
    margin:0; background:var(--bg); color:var(--ink); font-family:var(--sans);
    line-height:1.6; -webkit-font-smoothing:antialiased;
    background-image:radial-gradient(var(--line) 1px,transparent 1px);
    background-size:22px 22px;
  }
  .wrap{max-width:880px; margin:0 auto; padding:0 22px}
  header{display:flex; align-items:baseline; justify-content:space-between; padding:54px 0 10px}
  h1{font-family:var(--mono); font-size:clamp(26px,5vw,40px); margin:0; letter-spacing:-.5px}
  h1 .dot{color:var(--accent)}
  .tag{color:var(--dim); font-family:var(--mono); font-size:13px; margin:6px 0 0}
  .toggle{cursor:pointer; border:1px solid var(--line); background:var(--panel); color:var(--ink);
    width:40px; height:40px; border-radius:50%; font-size:18px; line-height:1;
    transition:transform .35s ease, border-color .2s; display:grid; place-items:center}
  .toggle:hover{transform:rotate(35deg); border-color:var(--accent)}
  .lead{color:var(--dim); font-size:14.5px; max-width:70ch; margin:14px 0 38px; border-left:2px solid var(--accent); padding-left:14px}
  section{margin:0 0 32px}
  .sechead{display:flex; align-items:center; gap:12px; margin:0 0 12px}
  .sechead .no{font-family:var(--mono); font-size:12px; color:var(--accent); border:1px solid var(--accent-soft); background:var(--accent-soft); padding:2px 7px; border-radius:4px}
  .sechead h2{font-size:17px; margin:0; font-weight:600}
  .sechead .hint{color:var(--dim); font-size:12.5px; font-family:var(--mono); margin-left:auto}
  .codewrap{position:relative; margin:10px 0}
  pre{background:var(--panel); border:1px solid var(--line); border-radius:8px;
    padding:14px 16px; overflow:auto; font-family:var(--mono); font-size:13px; margin:0}
  .cp{position:absolute; top:8px; right:8px; cursor:pointer; border:1px solid var(--line);
    background:var(--bg); color:var(--dim); font-family:var(--mono); font-size:11px; padding:3px 8px; border-radius:5px}
  .cp:hover{color:var(--accent); border-color:var(--accent)}
  .cp.ok{color:#39c07a; border-color:#39c07a}
  footer{border-top:1px solid var(--line); margin-top:30px; padding:24px 0 50px; color:var(--dim); font-family:var(--mono); font-size:12px; display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px}
  footer .blink{color:var(--accent)}
  a.dom{font-family:var(--mono); color:var(--accent); text-decoration:none}
  .reveal{opacity:0; transform:translateY(8px); animation:rise .5s ease forwards}
  @keyframes rise{to{opacity:1; transform:none}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>${brand}</h1>
      <p class="tag">all-in-one pull-through mirror · path-dispatched</p>
    </div>
    <button class="toggle" id="t" title="Toggle theme" aria-label="Toggle theme">◐</button>
  </header>
  <p class="lead">One hostname, no per-service subdomains. Docker uses <code>/v2/&lt;registry&gt;/…</code> or <code>/v2/r/&lt;registry-host&gt;/…</code> (login credentials pass through; nothing is stored). Everything else is <code>/&lt;service&gt;/…</code>. Markdown version: <a class="dom" href="/docs">curl /docs</a>.</p>
  ${body}
  <footer>
    <span><a class="dom" href="https://github.com/RandallAnjie/proxies-hub" target="_blank" rel="noopener">github.com/RandallAnjie/proxies-hub</a></span>
    <span>Powered By <span class="blink">Randall</span></span>
  </footer>
</div>
<script>
(function(){
  var root=document.documentElement, k='proxies-theme';
  var saved=localStorage.getItem(k);
  if(saved) root.dataset.theme=saved;
  else if(window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches) root.dataset.theme='light';
  document.getElementById('t').onclick=function(){
    var n=root.dataset.theme==='dark'?'light':'dark';
    root.dataset.theme=n; localStorage.setItem(k,n);
  };
  document.querySelectorAll('.cp').forEach(function(b){
    b.onclick=function(){
      var code=b.parentElement.querySelector('code').innerText;
      navigator.clipboard.writeText(code).then(function(){
        b.textContent='copied'; b.classList.add('ok');
        setTimeout(function(){b.textContent='copy'; b.classList.remove('ok');},1400);
      });
    };
  });
})();
</script>
</body>
</html>
<!-- markdown source also served to curl/wget
${md.replace(/-->/g, "->")}
-->`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function isMarkdownUa(ua: string): boolean {
  const u = ua.toLowerCase();
  return !u || u.includes("curl") || u.includes("wget");
}
