/**
 * =================================================================================
 * 项目: photostock-2api (Cloudflare Worker 单文件版)
 * 版本: 3.0.0 (代号: Proxy Stream - The Ultimate Render)
 * 作者: 首席AI执行官 (Principal AI Executive Officer)
 * 协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
 * 日期: 2025-12-01
 * 
 * [v3.0.0 颠覆性更新]
 * 1. [Feat] 实现 "动态代理渲染" (Dynamic Proxy Rendering)。
 *    - 思路: Worker 充当图片服务器。Chat 接口仅返回 Worker 自身的 URL。
 *    - 效果: 完美解决 Cherry Studio / NextChat 等所有客户端无法渲染 Base64 的问题。
 * 2. [Fix] 保持 Web UI 兼容性。
 *    - Web UI 继续使用 JSON/Base64 接口，互不干扰。
 * 3. [Sec] 继承 v2.5.0 的 CSRF Token 自动防御机制。
 * =================================================================================
 */

// --- [第一部分: 核心配置] ---
const CONFIG = {
  PROJECT_NAME: "photostock-2api",
  PROJECT_VERSION: "3.0.0",
  
  // 安全配置: 设置为 "1" 可使用 "Bearer 1" 进行测试
  API_MASTER_KEY: "1", 
  
  // 上游地址
  UPSTREAM_HOME: "https://photostockeditor.com/tools/free-ai-image-generator",
  UPSTREAM_API: "https://photostockeditor.com/tools/free-ai-image-generator",
  
  // 伪装头 (模拟 Chrome 浏览器)
  BASE_HEADERS: {
    "Host": "photostockeditor.com",
    "Origin": "https://photostockeditor.com",
    "Referer": "https://photostockeditor.com/tools/free-ai-image-generator",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Ch-Ua": '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    "Priority": "u=0, i"
  },

  MODELS: ["photostock-standard", "gpt-4o", "dall-e-3"],
  DEFAULT_MODEL: "photostock-standard"
};

// --- [第二部分: Worker 入口] ---
export default {
  async fetch(request, env, ctx) {
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    const url = new URL(request.url);

    // 1. 预检请求
    if (request.method === 'OPTIONS') return handleCorsPreflight();
    
    // 2. 开发者 UI (Web UI)
    if (url.pathname === '/') return handleUI(request, apiKey);
    
    // 3. 图片代理渲染接口 (核心新功能)
    // 这个接口不需要鉴权，因为它是嵌入在 Markdown 图片链接里的，客户端加载图片时无法带 Header
    if (url.pathname === '/v1/view') return handleViewImage(request);

    // 4. API 接口
    if (url.pathname.startsWith('/v1/')) return handleApi(request, apiKey);
    
    return createErrorResponse(`路径未找到: ${url.pathname}`, 404, 'not_found');
  }
};

// --- [第三部分: 核心业务逻辑 (Session & Generation)] ---

/**
 * 获取上游会话 (Cookie + CSRF Token)
 */
async function getUpstreamSessionData() {
  try {
    const resp = await fetch(CONFIG.UPSTREAM_HOME, {
      method: 'GET',
      headers: CONFIG.BASE_HEADERS
    });
    
    const html = await resp.text();
    
    // 提取 Cookie
    const setCookie = resp.headers.get('set-cookie');
    const cookie = setCookie ? setCookie.split(',').map(c => c.split(';')[0]).join('; ') : "";

    // 提取 CSRF Token
    const tokenRegex = /<input type="hidden" name="_token" value="([^"]+)">/;
    const match = html.match(tokenRegex);
    const token = match ? match[1] : "";

    return { cookie, token };
  } catch (e) {
    console.error("获取会话失败:", e);
    return { cookie: "", token: "" };
  }
}

/**
 * 执行生成任务 (返回 Base64 字符串)
 */
async function performGeneration(prompt) {
  const { cookie, token } = await getUpstreamSessionData();
  
  const headers = {
    ...CONFIG.BASE_HEADERS,
    "Content-Type": "application/x-www-form-urlencoded",
    "Cookie": cookie 
  };

  const body = new URLSearchParams();
  body.append('prompt', prompt);
  if (token) body.append('_token', token);

  const response = await fetch(CONFIG.UPSTREAM_API, {
    method: "POST",
    headers: headers,
    body: body
  });

  if (!response.ok) {
    throw new Error(`上游服务错误: ${response.status}`);
  }

  const html = await response.text();
  const regex = /src=["'](data:image\/[^;]+;base64,[^"']+)["']/i;
  const match = html.match(regex);

  if (!match || !match[1]) {
    if (html.includes("<title>Free AI Image Generator")) {
      throw new Error(`CSRF 验证失败，请重试。`);
    }
    throw new Error(`无法提取图片数据`);
  }

  return match[1]; 
}

// --- [第四部分: API 路由处理] ---

async function handleApi(request, apiKey) {
  if (!verifyAuth(request, apiKey)) return createErrorResponse('Unauthorized', 401, 'unauthorized');

  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') return handleModelsRequest();
  if (url.pathname === '/v1/images/generations') return handleImageGenerations(request, requestId);
  if (url.pathname === '/v1/chat/completions') return handleChatCompletions(request, requestId);
  
  return createErrorResponse('Not Found', 404, 'not_found');
}

// [新功能] 图片代理处理器
// 当 Cherry Studio 加载图片链接时，会访问这里
async function handleViewImage(request) {
  const url = new URL(request.url);
  const encodedPrompt = url.searchParams.get('p');
  
  if (!encodedPrompt) {
    return new Response("Missing prompt", { status: 400 });
  }

  try {
    // 1. 解码提示词
    const prompt = decodeURIComponent(atob(encodedPrompt));
    
    // 2. 现场生成图片 (获取 Base64)
    const dataUri = await performGeneration(prompt);
    
    // 3. 将 Base64 转换为二进制 Buffer
    const base64String = dataUri.split(',')[1];
    const binaryString = atob(base64String);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // 4. 返回标准图片流 (浏览器/客户端可直接渲染)
    return new Response(bytes.buffer, {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=31536000", // 建议缓存
        "Access-Control-Allow-Origin": "*"
      }
    });

  } catch (e) {
    // 生成失败返回一张错误图片 (可选，这里简单返回文字)
    return new Response(`Image Generation Failed: ${e.message}`, { status: 500 });
  }
}

// 绘图接口 (Web UI 专用) - 保持 JSON + Base64
async function handleImageGenerations(request, requestId) {
  try {
    const requestData = await request.json();
    const prompt = requestData.prompt;
    if (!prompt) throw new Error("Prompt is required");

    const dataUri = await performGeneration(prompt);
    const b64Json = dataUri.split(',')[1];

    return new Response(JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: b64Json }]
    }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });

  } catch (e) {
    return createErrorResponse(e.message, 500, 'generation_failed');
  }
}

// 聊天接口 (Cherry Studio 专用) - 返回 URL 链接
async function handleChatCompletions(request, requestId) {
  let requestData = {}; 
  try {
    requestData = await request.json();
    const messages = requestData.messages || [];
    const lastMsg = messages.reverse().find(m => m.role === 'user');
    if (!lastMsg) throw new Error("No user message found");

    const prompt = lastMsg.content;
    const model = requestData.model || CONFIG.DEFAULT_MODEL;
    const stream = requestData.stream || false;

    // [核心修改] 不再直接生成图片，而是构造一个指向本 Worker 的 URL
    // 1. 获取当前 Worker 的域名
    const origin = new URL(request.url).origin;
    
    // 2. 对提示词进行 Base64 编码 (防止 URL 乱码)
    const encodedPrompt = btoa(encodeURIComponent(prompt));
    
    // 3. 构造图片 URL
    const imageUrl = `${origin}/v1/view?p=${encodedPrompt}`;
    
    // 4. 构造 Markdown 内容
    const content = `Here is your image:\n\n![Generated Image](${imageUrl})\n\n[📥 Download Link](${imageUrl})`;

    // 5. 返回响应 (流式或非流式)
    if (stream) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      (async () => {
        const chunk = {
          id: requestId, object: 'chat.completion.chunk', created: Date.now()/1000, model: model,
          choices: [{ index: 0, delta: { content: content }, finish_reason: null }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        const endChunk = {
          id: requestId, object: 'chat.completion.chunk', created: Date.now()/1000, model: model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
        await writer.write(encoder.encode('data: [DONE]\n\n'));
        await writer.close();
      })();
      return new Response(readable, { headers: corsHeaders({ 'Content-Type': 'text/event-stream' }) });
    } else {
      return new Response(JSON.stringify({
        id: requestId, object: "chat.completion", created: Date.now()/1000, model: model,
        choices: [{ index: 0, message: { role: "assistant", content: content }, finish_reason: "stop" }]
      }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
    }

  } catch (e) {
    return createErrorResponse(e.message, 500, 'internal_error');
  }
}

// --- 辅助函数 ---
function verifyAuth(request, validKey) {
  const authHeader = request.headers.get('Authorization');
  if (validKey === "1" && (!authHeader || authHeader === "Bearer 1")) return true;
  return authHeader && authHeader === `Bearer ${validKey}`;
}

function handleModelsRequest() {
  return new Response(JSON.stringify({
    object: 'list',
    data: CONFIG.MODELS.map(id => ({ id, object: 'model', created: Date.now(), owned_by: 'photostock-2api' }))
  }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
}

function createErrorResponse(message, status, code) {
  return new Response(JSON.stringify({ error: { message, type: 'api_error', code } }), {
    status, headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// --- [第五部分: 开发者驾驶舱 UI] ---
function handleUI(request, apiKey) {
  const origin = new URL(request.url).origin;
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 开发者驾驶舱</title>
    <style>
      :root { --bg: #121212; --panel: #1E1E1E; --border: #333; --text: #E0E0E0; --primary: #FFBF00; --input-bg: #2A2A2A; --success: #66BB6A; --error: #CF6679; }
      body { font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); margin: 0; height: 100vh; display: flex; overflow: hidden; }
      .sidebar { width: 380px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; overflow-y: auto; flex-shrink: 0; }
      .main { flex: 1; display: flex; flex-direction: column; padding: 20px; position: relative; }
      .box { background: #252525; padding: 15px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 20px; }
      .label { font-size: 12px; color: #888; margin-bottom: 8px; display: block; font-weight: 600; }
      .code-block { font-family: monospace; font-size: 12px; color: var(--primary); word-break: break-all; background: #111; padding: 10px; border-radius: 4px; cursor: pointer; }
      input, select, textarea { width: 100%; background: #333; border: 1px solid #444; color: #fff; padding: 10px; border-radius: 4px; margin-bottom: 15px; box-sizing: border-box; font-family: inherit; }
      button { width: 100%; padding: 12px; background: var(--primary); border: none; border-radius: 4px; font-weight: bold; cursor: pointer; color: #000; }
      button:disabled { background: #555; cursor: not-allowed; }
      .chat-window { flex: 1; background: #000; border: 1px solid var(--border); border-radius: 8px; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; }
      .msg { max-width: 85%; padding: 15px; border-radius: 8px; line-height: 1.6; }
      .msg.user { align-self: flex-end; background: #333; color: #fff; }
      .msg.ai { align-self: flex-start; background: #1a1a1a; border: 1px solid #333; width: 100%; }
      .msg img { max-width: 100%; border-radius: 4px; display: block; margin-top: 10px; cursor: zoom-in; }
      .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #555; margin-right: 5px; }
      .status-dot.ok { background: var(--success); box-shadow: 0 0 5px var(--success); }
      .status-dot.err { background: var(--error); }
      .generating { animation: pulse 1.5s infinite; }
      @keyframes pulse { 0% { opacity: 0.6; } 50% { opacity: 1; } 100% { opacity: 0.6; } }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2 style="margin-top:0; display:flex; align-items:center; gap:10px;">
            📸 ${CONFIG.PROJECT_NAME} <span style="font-size:12px;color:#888">v${CONFIG.PROJECT_VERSION}</span>
        </h2>
        <div class="box">
            <span class="label">API 密钥</span>
            <div class="code-block" onclick="copy('${apiKey}')">${apiKey}</div>
        </div>
        <div class="box">
            <span class="label">API 接口 (ComfyUI / Image)</span>
            <div class="code-block" onclick="copy('${origin}/v1/images/generations')">${origin}/v1/images/generations</div>
            <span class="label" style="margin-top:10px;">API 接口 (Cherry Studio / Chat)</span>
            <div class="code-block" onclick="copy('${origin}/v1/chat/completions')">${origin}/v1/chat/completions</div>
        </div>
        <div class="box">
            <span class="label">提示词</span>
            <textarea id="prompt" rows="4" placeholder="A futuristic city..."></textarea>
            <button id="btn-gen" onclick="generate()">🎨 开始生成</button>
        </div>
        <div style="font-size:12px; color:#666; text-align:center;">
            <span id="status-dot" class="status-dot"></span> <span id="status-text">检查服务中...</span>
        </div>
    </div>
    <main class="main">
        <div class="chat-window" id="chat">
            <div style="color:#666; text-align:center; margin-top:100px;">
                <div style="font-size:40px; margin-bottom:20px;">🖼️</div>
                <h3>PhotoStock 代理服务就绪</h3>
                <p>已启用动态代理渲染 (Dynamic Proxy Rendering)。</p>
                <p style="font-size:12px; color:#666">Cherry Studio 现可完美显示图片。</p>
            </div>
        </div>
    </main>
    <script>
        const API_KEY = "${apiKey}";
        const ENDPOINT = "${origin}/v1/images/generations"; 
        
        function copy(text) { navigator.clipboard.writeText(text); alert('已复制'); }
        function appendMsg(role, html) {
            const div = document.createElement('div'); div.className = \`msg \${role}\`; div.innerHTML = html;
            document.getElementById('chat').appendChild(div); div.scrollIntoView({ behavior: "smooth" }); return div;
        }

        async function generate() {
            const prompt = document.getElementById('prompt').value.trim();
            if (!prompt) return alert('请输入提示词');
            const btn = document.getElementById('btn-gen');
            btn.disabled = true; btn.innerHTML = '⏳ 生成中...';
            if(document.querySelector('.chat-window').innerText.includes('代理服务就绪')) document.getElementById('chat').innerHTML = '';
            
            appendMsg('user', prompt);
            const loadingMsg = appendMsg('ai', \`<div class="generating">🤖 正在请求 (自动获取 Session)...</div>\`);
            const startTime = Date.now();

            try {
                const res = await fetch(ENDPOINT, {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: prompt, n: 1, size: "1024x1024" })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error?.message || '生成失败');

                const b64 = data.data[0].b64_json;
                const imgSrc = \`data:image/webp;base64,\${b64}\`;
                const duration = ((Date.now() - startTime) / 1000).toFixed(2);

                loadingMsg.innerHTML = \`
                    <div style="color:#66BB6A; font-weight:bold; margin-bottom:10px;">✨ 生成成功 (\${duration}s)!</div>
                    <img src="\${imgSrc}" onclick="window.open(this.src)">
                    <div style="margin-top:10px;"><a href="\${imgSrc}" download="img.webp" style="color:var(--primary);text-decoration:none;font-size:12px;">⬇️ 下载图片</a></div>
                \`;
            } catch (e) {
                loadingMsg.innerHTML = \`<div style="color:#CF6679; font-weight:bold;">❌ 生成失败</div><div style="font-size:12px; margin-top:5px; color:#aaa;">\${e.message}</div>\`;
            } finally {
                btn.disabled = false; btn.innerHTML = '🎨 开始生成';
            }
        }

        window.onload = async () => {
            const dot = document.getElementById('status-dot'); const text = document.getElementById('status-text');
            try {
                const res = await fetch('${origin}/v1/models', { headers: { 'Authorization': 'Bearer ' + API_KEY } });
                if(res.ok) { dot.classList.add('ok'); text.innerText = "服务正常"; } else throw new Error();
            } catch(e) { dot.classList.add('err'); text.innerText = "服务异常"; }
        };
    </script>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
