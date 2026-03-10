(function () {
  const LOCAL_PROFILE_KEY = 'jingge_local_profile';
  const HUB_OVERLAY_ID = 'settings-hub-overlay';
  const IMPORT_STATE = { markdownName: '', importedAt: '', sourceMode: 'none', assets: new Map(), assetCount: 0 };
  const AUTO_SYNC_STATE = { phase: 'idle', total: 0, completed: 0, uploaded: 0, failed: 0, missing: 0, message: '' };
  const baseUpdatePreview = window.updatePreview;
  let autoSyncTimer = null;
  let autoSyncInFlight = null;

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function normalizeAssetPath(value) {
    if (!value) return '';
    let normalized = String(value).trim();
    if (!normalized) return '';
    if (normalized.startsWith('data:')) return normalized;
    normalized = normalized.split('#')[0].split('?')[0];
    try { normalized = decodeURIComponent(normalized); } catch (e) {}
    normalized = normalized.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
    return normalized.toLowerCase();
  }

  function isMarkdownFile(file) {
    return !!(file && /\.(md|markdown|txt)$/i.test(file.name || ''));
  }

  function isImageLikeFile(file) {
    if (!file) return false;
    if ((file.type || '').startsWith('image/')) return true;
    return /\.(png|jpe?g|gif|webp|svg|bmp|heic|heif|avif)$/i.test(file.name || '');
  }

  function guessFileContentType(file) {
    if (file && file.type) return file.type;
    const ext = ((file && file.name) ? file.name.split('.').pop() : '').toLowerCase();
    const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif' };
    return mimeMap[ext] || 'application/octet-stream';
  }

  function isCompleteOSSConfig(cfg) {
    return !!(cfg && cfg.accessKey && cfg.secretKey && cfg.bucket && cfg.endpoint);
  }

  function getLocalProfile() {
    try {
      const raw = localStorage.getItem(LOCAL_PROFILE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return { displayName: '', email: '' };
  }

  function dataUrlToFile(dataUrl, fallbackName) {
    const match = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/);
    if (!match) return null;
    const mime = match[1] || 'application/octet-stream';
    const isBase64 = !!match[2];
    const dataPart = match[3] || '';
    const binaryString = isBase64 ? atob(dataPart) : decodeURIComponent(dataPart);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
    const ext = (mime.split('/')[1] || 'png').replace('jpeg', 'jpg');
    return new File([bytes], `${fallbackName || 'pasted-image'}.${ext}`, { type: mime });
  }

  function rememberImportedAsset(file) {
    const keys = new Set();
    const nameKey = normalizeAssetPath(file.name);
    const relKey = normalizeAssetPath(file.webkitRelativePath || '');
    if (nameKey) keys.add(nameKey);
    if (relKey) {
      keys.add(relKey);
      const parts = relKey.split('/');
      for (let i = 1; i < parts.length; i++) keys.add(parts.slice(i).join('/'));
      if (parts.length > 1) keys.add(parts.slice(-2).join('/'));
    }
    keys.forEach((key) => { if (key && !IMPORT_STATE.assets.has(key)) IMPORT_STATE.assets.set(key, file); });
  }

  function registerImportedAssets(files, options) {
    const opts = options || {};
    const imageFiles = Array.from(files || []).filter(isImageLikeFile);
    if (opts.clear) IMPORT_STATE.assets = new Map();
    imageFiles.forEach(rememberImportedAsset);
    IMPORT_STATE.assetCount = new Set(Array.from(IMPORT_STATE.assets.values())).size;
    return imageFiles;
  }

  function resolveImportedFileForSource(src) {
    if (!src) return null;
    if (String(src).startsWith('data:')) return dataUrlToFile(src, 'pasted-image');
    const normalized = normalizeAssetPath(src);
    if (!normalized) return null;
    const candidates = new Set([normalized]);
    const parts = normalized.split('/');
    for (let i = 1; i < parts.length; i++) candidates.add(parts.slice(i).join('/'));
    candidates.add(parts[parts.length - 1]);
    if (parts.length > 1) candidates.add(parts.slice(-2).join('/'));
    for (const key of candidates) {
      if (key && IMPORT_STATE.assets.has(key)) return IMPORT_STATE.assets.get(key);
    }
    return null;
  }

  function extractMarkdownImageSources(md) {
    const sources = [];
    const regex = /!\[[^\]]*\]\(([^)]+)\)/g;
    let match;
    while ((match = regex.exec(md || '')) !== null) {
      const src = (match[1] || '').trim();
      if (src) sources.push(src);
    }
    return sources;
  }

  function isRemoteImageSource(src) {
    return /^(https?:)?\/\//i.test(src || '');
  }

  function getPendingLocalImageSources(md) {
    return Array.from(new Set(extractMarkdownImageSources(md).filter((src) => !isRemoteImageSource(src))));
  }

  function replaceExactImageReference(md, originalSrc, nextSrc) {
    const re = new RegExp('(!\\[[^\\]]*\\]\\()' + escapeRegExp(originalSrc) + '(\\))', 'g');
    return md.replace(re, '$1' + nextSrc + '$2');
  }

  function replaceImageReferencesByFileName(md, fileName, nextSrc) {
    const fname = escapeRegExp(fileName);
    const re = new RegExp('(!\\[[^\\]]*\\]\\()([^)]*[/\\\\]?)' + fname + '(\\))', 'g');
    let updated = md.replace(re, '$1' + nextSrc + '$3');
    const re2 = new RegExp('(!\\[[^\\]]*\\]\\()' + fname + '(\\))', 'g');
    return updated.replace(re2, '$1' + nextSrc + '$2');
  }

  function ensureImportInputs() {
    if (!document.getElementById('import-bundle-input')) {
      const input = document.createElement('input');
      input.type = 'file';
      input.id = 'import-bundle-input';
      input.accept = '.md,.markdown,.txt,image/*';
      input.multiple = true;
      input.style.display = 'none';
      input.onchange = function () { window.handleImportBundle(this.files); this.value = ''; };
      document.body.appendChild(input);
    }
    if (!document.getElementById('import-folder-input')) {
      const input = document.createElement('input');
      input.type = 'file';
      input.id = 'import-folder-input';
      input.multiple = true;
      input.style.display = 'none';
      input.setAttribute('webkitdirectory', '');
      input.setAttribute('directory', '');
      input.onchange = function () { window.handleImportFolder(this.files); this.value = ''; };
      document.body.appendChild(input);
    }
  }

  function injectSettingsHubStyles() {
    if (document.getElementById('settings-hub-style')) return;
    const style = document.createElement('style');
    style.id = 'settings-hub-style';
    style.textContent = `
      .settings-hub-overlay { backdrop-filter: blur(10px); background: rgba(3, 6, 10, 0.72); }
      .settings-hub-modal { width: min(980px, calc(100vw - 48px)); max-height: 88vh; overflow: hidden; border-radius: 24px; border: 1px solid rgba(77, 90, 110, 0.35); background: radial-gradient(circle at top right, rgba(45, 212, 168, 0.12), transparent 28%), linear-gradient(180deg, rgba(18, 21, 28, 0.98), rgba(9, 11, 16, 0.98)); box-shadow: 0 36px 120px rgba(0, 0, 0, 0.5); display: flex; flex-direction: column; }
      .settings-hub-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 28px 28px 18px; border-bottom: 1px solid rgba(69, 78, 96, 0.32); }
      .settings-hub-head h3 { margin: 6px 0 8px; font-size: 26px; color: #f5f7fb; letter-spacing: 0.04em; }
      .settings-hub-head p { margin: 0; color: #8e9bb1; font-size: 13px; line-height: 1.7; max-width: 580px; }
      .settings-eyebrow { font-size: 11px; text-transform: uppercase; letter-spacing: 0.24em; color: #2dd4a8; }
      .settings-hub-close { width: 42px; height: 42px; border-radius: 12px; border: 1px solid rgba(79, 93, 115, 0.35); background: rgba(20, 24, 31, 0.76); color: #aab4c4; font-size: 22px; cursor: pointer; }
      .settings-hub-tabs { display: flex; gap: 10px; padding: 16px 28px 0; flex-wrap: wrap; }
      .settings-hub-tab { border: 1px solid rgba(79, 93, 115, 0.35); background: rgba(15, 18, 25, 0.75); color: #8f9bad; border-radius: 999px; padding: 9px 16px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.18s ease; }
      .settings-hub-tab.active { color: #07120d; background: #2dd4a8; border-color: #2dd4a8; box-shadow: 0 0 0 6px rgba(45, 212, 168, 0.12); }
      .settings-hub-body { padding: 24px 28px 28px; overflow-y: auto; }
      .settings-hub-panel { display: none; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
      .settings-hub-panel.active { display: grid; }
      .settings-card { background: linear-gradient(180deg, rgba(19, 24, 31, 0.92), rgba(11, 14, 20, 0.94)); border: 1px solid rgba(69, 78, 96, 0.32); border-radius: 20px; padding: 20px; min-height: 120px; }
      .settings-card.full { grid-column: 1 / -1; }
      .settings-card h4 { margin: 0 0 8px; font-size: 16px; color: #eef3f9; }
      .settings-card p { margin: 0 0 16px; color: #8e9bb1; font-size: 13px; line-height: 1.7; }
      .settings-status-line { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; background: rgba(8, 10, 14, 0.7); border: 1px solid rgba(69, 78, 96, 0.26); border-radius: 14px; margin-bottom: 12px; }
      .settings-status-line strong { color: #f0f4fb; font-size: 13px; }
      .settings-status-line span { color: #aab4c4; font-size: 12px; text-align: right; }
      .settings-chip.dim { color: #b9c2d0; background: rgba(66, 76, 95, 0.45); display: inline-flex; align-items: center; padding: 6px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; }
      .settings-field-grid, .settings-info-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      .settings-hub-modal .setting-group { margin-bottom: 16px; }
      .settings-hub-modal .setting-group label { display: block; margin-bottom: 8px; color: #98a6ba; font-size: 12px; }
      .settings-hub-modal input[type="text"], .settings-hub-modal input[type="password"], .settings-hub-modal select { width: 100%; padding: 11px 12px; border-radius: 12px; border: 1px solid rgba(69, 78, 96, 0.34); background: rgba(7, 9, 14, 0.72); color: #eef3f9; font-size: 13px; font-family: inherit; box-sizing: border-box; }
      .settings-actions { display: flex; gap: 10px; flex-wrap: wrap; }
      .settings-primary-btn, .settings-secondary-btn { border-radius: 12px; padding: 11px 16px; font-size: 13px; font-weight: 700; font-family: inherit; cursor: pointer; }
      .settings-primary-btn { border: none; color: #07120d; background: linear-gradient(135deg, #2dd4a8, #5eead4); }
      .settings-secondary-btn { border: 1px solid rgba(69, 78, 96, 0.34); color: #b8c2cf; background: rgba(13, 16, 23, 0.76); }
      .settings-log { margin-top: 14px; max-height: 170px; overflow-y: auto; background: rgba(6, 8, 12, 0.82); border: 1px solid rgba(69, 78, 96, 0.24); border-radius: 14px; padding: 12px 14px; color: #c1cad8; font-size: 12px; line-height: 1.7; display: none; }
      .settings-log-row { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 8px; }
      .settings-log-row:last-child { margin-bottom: 0; }
      .settings-log-row a { color: #5eead4; word-break: break-all; }
      .settings-mini-note { margin-top: 8px; color: #6f7d93; font-size: 12px; line-height: 1.6; }
      .settings-mini-card { padding: 14px; border-radius: 14px; background: rgba(8, 11, 15, 0.72); border: 1px solid rgba(69, 78, 96, 0.26); }
      .settings-mini-card strong { display: block; margin-bottom: 6px; color: #eef3f9; font-size: 13px; }
      .settings-mini-card span, .settings-account-hero span { color: #8e9bb1; font-size: 12px; line-height: 1.6; }
      .settings-hub-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 28px 24px; border-top: 1px solid rgba(69, 78, 96, 0.32); }
      .settings-hub-footer-note { color: #7f8ba0; font-size: 12px; line-height: 1.7; }
      .settings-account-hero { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 14px 16px; border-radius: 16px; margin-bottom: 16px; background: rgba(8, 11, 15, 0.72); border: 1px solid rgba(69, 78, 96, 0.26); }
      .settings-account-hero strong { display: block; color: #eef3f9; margin-bottom: 4px; }
      @media (max-width: 860px) { .settings-hub-modal { width: calc(100vw - 20px); max-height: 92vh; } .settings-hub-head, .settings-hub-body, .settings-hub-footer, .settings-hub-tabs { padding-left: 18px; padding-right: 18px; } .settings-hub-panel, .settings-field-grid, .settings-info-grid { grid-template-columns: 1fr; } .settings-hub-footer { flex-direction: column; align-items: flex-start; } }
    `;
    document.head.appendChild(style);
  }

  function injectSettingsHubMarkup() {
    const currentHub = document.getElementById(HUB_OVERLAY_ID);
    if (currentHub) currentHub.remove();
    ['settings-overlay', 'ai-settings-overlay', 'oss-settings-overlay'].forEach((id) => {
      const node = document.getElementById(id);
      if (node) node.remove();
    });
    document.body.insertAdjacentHTML('beforeend', `
      <div class="settings-overlay settings-hub-overlay" id="${HUB_OVERLAY_ID}" onclick="if(event.target===this)closeSettings()"><div class="settings-hub-modal"><div class="settings-hub-head"><div><div class="settings-eyebrow">Workspace Control</div><h3>设置中心</h3><p>把排版参数、AI、图床和账号状态收进一个工作台里。导入 Markdown 或粘贴带图内容后，会优先尝试把本地图片同步到 OSS，再刷新预览。</p></div><button class="settings-hub-close" onclick="closeSettings()" aria-label="关闭">×</button></div><div class="settings-hub-tabs"><button class="settings-hub-tab active" data-settings-tab="appearance" onclick="switchSettingsTab('appearance')">排版</button><button class="settings-hub-tab" data-settings-tab="ai" onclick="switchSettingsTab('ai')">AI</button><button class="settings-hub-tab" data-settings-tab="media" onclick="switchSettingsTab('media')">图床与导入</button><button class="settings-hub-tab" data-settings-tab="account" onclick="switchSettingsTab('account')">账号</button></div><div class="settings-hub-body">
        <section class="settings-hub-panel active" data-tab-panel="appearance"><div class="settings-card"><h4>基础观感</h4><p>在当前模板上做微调，适合快速收紧整篇文章的色彩与阅读氛围。</p><div class="setting-group"><label>主题色</label><div class="setting-row"><input type="color" id="s-accent" value="#2dd4a8" onchange="updateSetting()"><span class="setting-value" id="sv-accent">#2dd4a8</span></div></div><div class="setting-group"><label>正文背景</label><div class="setting-row"><input type="color" id="s-bg" value="#111111" onchange="updateSetting()"><span class="setting-value" id="sv-bg">#111111</span></div></div><div class="setting-group"><label>正文颜色</label><div class="setting-row"><input type="color" id="s-textcolor" value="#c8c8c8" onchange="updateSetting()"><span class="setting-value" id="sv-textcolor">#c8c8c8</span></div></div></div><div class="settings-card"><h4>节奏与密度</h4><p>这里更适合处理公众号里“正文挤不挤、读起来顺不顺”的问题。</p><div class="setting-group"><label>正文字号</label><div class="setting-row"><input type="range" id="s-fontsize" min="11" max="22" value="16" onchange="updateSetting()"><span class="setting-value" id="sv-fontsize">16px</span></div></div><div class="setting-group"><label>行高</label><div class="setting-row"><input type="range" id="s-lineheight" min="16" max="28" value="20" step="1" onchange="updateSetting()"><span class="setting-value" id="sv-lineheight">2.0</span></div></div><div class="setting-group"><label>段间距</label><div class="setting-row"><input type="range" id="s-paragap" min="8" max="24" value="16" step="2" onchange="updateSetting()"><span class="setting-value" id="sv-paragap">1.6em</span></div></div></div><div class="settings-card full"><h4>输出附加项</h4><p>控制复制给微信时要不要自动带上固定结尾区块。</p><div class="setting-group" style="margin-bottom:0;"><label style="display:flex;align-items:center;gap:10px;margin-bottom:0;"><input type="checkbox" id="s-show-footer" checked onchange="showFixedFooter=this.checked;updatePreview();"><span>复制到微信时保留固定结尾区块</span></label></div></div></section>
        <section class="settings-hub-panel" data-tab-panel="ai"><div class="settings-card"><h4>AI 配置</h4><p>用于 AI 优化和指令改写。现在还是本地模式，配置会保存在当前浏览器。</p><div class="settings-status-line"><strong>当前状态</strong><span id="ai-config-status">未配置</span></div><div class="setting-group"><label>使用服务</label><select id="ai-provider" onchange="toggleAICustomFields()"><option value="zhipu">智谱 GLM（只需 API Key）</option><option value="custom">自定义 OpenAI 兼容接口</option></select></div><div class="setting-group"><label id="ai-api-key-label">API Key</label><input type="password" id="ai-api-key" autocomplete="off" placeholder="输入你的 API Key"></div><div class="setting-group" id="ai-custom-fields" style="display:none;"><label>API 地址</label><input type="text" id="ai-api-url" placeholder="https://api.openai.com/v1/chat/completions"></div><div class="setting-group" id="ai-custom-model-wrap" style="display:none;"><label>模型</label><input type="text" id="ai-model" placeholder="gpt-4o"></div><div class="settings-actions"><button class="settings-primary-btn" onclick="saveAISettings()">保存 AI 配置</button></div></div><div class="settings-card"><h4>建议用法</h4><div class="settings-info-grid"><div class="settings-mini-card"><strong>AI 优化</strong><span>适合把普通 Markdown 快速重写成当前模板下更完整的排版稿。</span></div><div class="settings-mini-card"><strong>AI 指令</strong><span>更适合做局部修改，比如插入卡片、替换组件风格或补一句引导语。</span></div><div class="settings-mini-card"><strong>本地存储</strong><span>现在只是单文件版本，部署多人版前，建议把 API Key 改为服务端加密存储。</span></div><div class="settings-mini-card"><strong>后续升级</strong><span>如果你要加登录和团队协作，这里最适合先抽成独立配置服务。</span></div></div></div></section>
        <section class="settings-hub-panel" data-tab-panel="media"><div class="settings-card"><h4>导入 Markdown 文档</h4><p>更接近真实使用场景：把 Markdown 和配图一起导入后，就立刻开始检查并上传本地图片，预览不必等到复制微信时才修正。</p><div class="settings-status-line"><strong>导入状态</strong><span id="import-source-status">还没有导入文档</span></div><div class="settings-status-line"><strong>资源库</strong><span id="import-asset-status">0 张图片已索引</span></div><div class="settings-status-line"><strong>正文检测</strong><span id="media-local-summary">当前正文没有本地图片</span></div><div class="settings-actions"><button class="settings-primary-btn" onclick="triggerImportBundle()">导入 Markdown + 图片</button><button class="settings-secondary-btn" onclick="triggerImportFolder()">导入整个文章目录</button></div><div class="settings-mini-note">如果正文里引用的是相对路径图片，建议直接导入整篇文章目录，自动匹配会更稳。</div></div><div class="settings-card"><h4>图床 / OSS 配置</h4><p>只要正文里检测到本地图片，系统会优先尝试即时上传到 OSS。手动上传按钮仍然保留，适合零星补图。</p><div class="settings-status-line"><strong>图床状态</strong><span id="oss-config-status">未配置</span></div><div class="settings-field-grid"><div class="setting-group"><label>AccessKeyId</label><input type="text" id="oss-access-key" placeholder="输入 AccessKeyId"></div><div class="setting-group"><label>AccessKeySecret</label><input type="password" id="oss-secret-key" autocomplete="off" placeholder="输入 AccessKeySecret"></div><div class="setting-group"><label>Bucket 名称</label><input type="text" id="oss-bucket" placeholder="如：wechat-assets"></div><div class="setting-group"><label>Endpoint</label><input type="text" id="oss-endpoint" placeholder="如：oss-cn-beijing.aliyuncs.com"></div><div class="setting-group"><label>自定义域名（可选）</label><input type="text" id="oss-custom-domain" placeholder="如：https://cdn.example.com"></div><div class="setting-group"><label>上传前缀（可选）</label><input type="text" id="oss-prefix" placeholder="如：articles/2026/"></div></div><div class="settings-actions"><button class="settings-primary-btn" onclick="saveOSSSettings()">保存图床配置</button><button class="settings-secondary-btn" onclick="triggerManualImageUpload()">手动上传图片</button></div><input type="file" id="oss-file-input" multiple accept="image/*" style="display:none" onchange="handleOSSUpload(this.files); this.value='';"><div class="settings-mini-note">浏览器直传时，Bucket 需要允许 PUT / GET / OPTIONS，并放行 Authorization、x-oss-date、Content-Type。</div><div id="oss-upload-log" class="settings-log"></div></div><div class="settings-card full"><h4>当前自动化策略</h4><div class="settings-info-grid"><div class="settings-mini-card"><strong>导入或粘贴后立即同步</strong><span>导入 Markdown、导入文章目录，或粘贴带图片的内容后，会优先检查正文里的本地图片并尝试上传 OSS。</span></div><div class="settings-mini-card"><strong>复制阶段只做兜底检查</strong><span>点击“复制到微信”时仍会再检查一遍，避免漏掉未同步的本地图片。</span></div></div></div></section>
        <section class="settings-hub-panel" data-tab-panel="account"><div class="settings-card"><h4>本地工作台身份</h4><div class="settings-account-hero"><div><strong>当前还是本地单文件模式</strong><span id="account-storage-summary">配置项保存在当前浏览器里，刷新可保留，换机器不会同步。</span></div><span class="settings-chip dim">LOCAL</span></div><div class="settings-field-grid"><div class="setting-group"><label>显示名称</label><input type="text" id="local-display-name" placeholder="比如：镜哥排版工作台"></div><div class="setting-group"><label>联系邮箱</label><input type="text" id="local-email" placeholder="可选，仅做本地记录"></div></div><div class="settings-actions"><button class="settings-primary-btn" onclick="saveLocalWorkspaceProfile()">保存本地资料</button></div></div><div class="settings-card"><h4>服务器版建议</h4><div class="settings-info-grid"><div class="settings-mini-card"><strong>登录方式</strong><span>优先接邮箱验证码、GitHub 或微信登录，前端只保留会话，不直接接触永久密钥。</span></div><div class="settings-mini-card"><strong>配置存储</strong><span>AI Key、OSS 配置建议入库前加密，读取时由服务端解密使用，前端只看到掩码值。</span></div><div class="settings-mini-card"><strong>OSS 上传</strong><span>不要把永久 AccessKey 放到浏览器。多人版应改成 STS 或服务端签名上传。</span></div><div class="settings-mini-card"><strong>推荐拆分</strong><span>如果继续做账号和发布，建议把单 HTML 拆成前端界面 + 配置 API + 上传签名服务。</span></div></div></div></section>
      </div><div class="settings-hub-footer"><div class="settings-hub-footer-note" id="settings-footer-note">当前是本地模式，敏感配置仍存放在浏览器本地。多人部署时建议迁移到服务端加密存储。</div><div class="settings-actions"><button class="settings-secondary-btn" onclick="closeSettings()">完成</button></div></div></div></div>`);
  }

  function upgradeToolbarActions() {
    const center = document.querySelector('.toolbar-center');
    if (!center) return;
    Array.from(center.querySelectorAll('.toolbar-btn')).forEach((btn) => {
      const handler = btn.getAttribute('onclick') || '';
      if (handler.includes('openAISettings') || handler.includes('openOSSSettings')) btn.remove();
    });
    const settingsBtn = Array.from(center.querySelectorAll('.toolbar-btn')).find((btn) => (btn.getAttribute('onclick') || '').includes('openSettings'));
    if (settingsBtn) {
      settingsBtn.textContent = '设置中心';
      settingsBtn.title = '打开统一设置中心';
    }
    if (!center.querySelector('[data-role="import-bundle"]')) {
      const importBtn = document.createElement('button');
      importBtn.className = 'toolbar-btn';
      importBtn.dataset.role = 'import-bundle';
      importBtn.textContent = '导入';
      importBtn.title = '导入 Markdown 文档和配图';
      importBtn.onclick = function () { window.triggerImportBundle(); };
      const helpBtn = Array.from(center.querySelectorAll('.toolbar-btn')).find((btn) => (btn.getAttribute('onclick') || '').includes('openHelp'));
      if (helpBtn) center.insertBefore(importBtn, helpBtn);
      else center.appendChild(importBtn);
    }
  }

  function bindAutoSyncEvents() {
    const ta = document.getElementById('markdown-input');
    if (!ta || ta.dataset.autoSyncBound === '1') return;
    ta.dataset.autoSyncBound = '1';
    ta.addEventListener('input', function () {
      scheduleAutoImageSync('input', { showToastOnStart: false, showToastOnSuccess: false, showToastOnBlocked: false }, 700);
    });
    ta.addEventListener('paste', function () {
      scheduleAutoImageSync('paste', { showToastOnStart: true, showToastOnSuccess: true, showToastOnBlocked: true }, 650);
    });
  }

  function initSettingsHub() {
    ensureImportInputs();
    if (!document.getElementById(HUB_OVERLAY_ID)) {
      injectSettingsHubStyles();
      injectSettingsHubMarkup();
    }
    upgradeToolbarActions();
    bindAutoSyncEvents();
    syncSettingsHubForms();
    syncSettingsHubStatus();
  }

  function switchSettingsTab(tab) {
    document.querySelectorAll('[data-settings-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.settingsTab === tab);
    });
    document.querySelectorAll('[data-tab-panel]').forEach((panel) => {
      panel.classList.toggle('active', panel.dataset.tabPanel === tab);
    });
  }

  function syncSettingsHubForms() {
    if (!document.getElementById(HUB_OVERLAY_ID)) return;
    window.syncSettingsFromConfig();
    const footerCb = document.getElementById('s-show-footer');
    if (footerCb) footerCb.checked = showFixedFooter;

    const ai = window.getAIConfig();
    const aiProvider = document.getElementById('ai-provider');
    const aiKey = document.getElementById('ai-api-key');
    const aiUrl = document.getElementById('ai-api-url');
    const aiModel = document.getElementById('ai-model');
    if (aiProvider) aiProvider.value = ai.provider || 'zhipu';
    if (aiKey) aiKey.value = ai.apiKey || '';
    if (aiUrl) aiUrl.value = ai.apiUrl || ZHIPU_GLM_API_URL;
    if (aiModel) aiModel.value = ai.model || ZHIPU_GLM_MODEL;
    window.toggleAICustomFields();

    const oss = window.getOSSConfig();
    const ossValues = {
      'oss-access-key': oss.accessKey || '',
      'oss-secret-key': oss.secretKey || '',
      'oss-bucket': oss.bucket || '',
      'oss-endpoint': oss.endpoint || '',
      'oss-custom-domain': oss.customDomain || '',
      'oss-prefix': oss.prefix || '',
    };
    Object.keys(ossValues).forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = ossValues[id];
    });

    const profile = getLocalProfile();
    const displayName = document.getElementById('local-display-name');
    const email = document.getElementById('local-email');
    if (displayName) displayName.value = profile.displayName || '';
    if (email) email.value = profile.email || '';
  }

  function syncSettingsHubStatus() {
    const editor = document.getElementById('markdown-input');
    const md = editor ? editor.value : '';
    const localImages = getPendingLocalImageSources(md);
    let resolvable = 0;
    localImages.forEach((src) => {
      if (String(src).startsWith('data:') || resolveImportedFileForSource(src)) resolvable++;
    });
    const unresolved = Math.max(localImages.length - resolvable, 0);

    const ai = window.getAIConfig();
    const aiStatus = document.getElementById('ai-config-status');
    if (aiStatus) aiStatus.textContent = ai.apiKey ? `已配置 ${ai.provider === 'custom' ? '自定义接口' : '智谱 GLM'}` : '未配置';

    const oss = window.getOSSConfig();
    const ossStatus = document.getElementById('oss-config-status');
    if (ossStatus) {
      ossStatus.textContent = (oss.accessKey && oss.secretKey && oss.bucket && oss.endpoint) ? `已就绪 · ${oss.bucket}` : '未完成配置';
    }

    const importStatus = document.getElementById('import-source-status');
    if (importStatus) {
      importStatus.textContent = IMPORT_STATE.markdownName ? `${IMPORT_STATE.markdownName}${IMPORT_STATE.importedAt ? ' · ' + IMPORT_STATE.importedAt : ''}` : '还没有导入文档';
    }

    const assetStatus = document.getElementById('import-asset-status');
    if (assetStatus) assetStatus.textContent = IMPORT_STATE.assetCount ? `${IMPORT_STATE.assetCount} 张图片已索引` : '0 张图片已索引';

    const mediaSummary = document.getElementById('media-local-summary');
    if (mediaSummary) {
      if (AUTO_SYNC_STATE.phase === 'running') mediaSummary.textContent = `正在上传 OSS：已处理 ${AUTO_SYNC_STATE.completed}/${AUTO_SYNC_STATE.total} 张图片`;
      else if (AUTO_SYNC_STATE.phase === 'done' && AUTO_SYNC_STATE.uploaded) mediaSummary.textContent = `已自动同步 ${AUTO_SYNC_STATE.uploaded} 张图片，预览已更新`;
      else if ((AUTO_SYNC_STATE.phase === 'blocked' || AUTO_SYNC_STATE.phase === 'partial') && AUTO_SYNC_STATE.message) mediaSummary.textContent = AUTO_SYNC_STATE.message;
      else if (!localImages.length) mediaSummary.textContent = '当前正文没有本地图片';
      else if (!unresolved) mediaSummary.textContent = `当前正文 ${localImages.length} 张本地图片，资源已就绪，可立即上传 OSS`;
      else mediaSummary.textContent = `当前正文 ${localImages.length} 张本地图片，仍有 ${unresolved} 张缺少对应资源`;
    }

    const footerNote = document.getElementById('settings-footer-note');
    if (footerNote) {
      if (AUTO_SYNC_STATE.phase === 'running') footerNote.textContent = '正在把正文里的本地图片同步到 OSS，完成后预览会自动刷新。';
      else if (AUTO_SYNC_STATE.phase === 'done' && AUTO_SYNC_STATE.uploaded) footerNote.textContent = '最近一次内容变更已经触发自动上传，正文里的本地图片已替换成 OSS 链接。';
      else if (localImages.length && unresolved === 0 && isCompleteOSSConfig(oss)) footerNote.textContent = '检测到正文中有本地图片，只要内容导入完成或再次粘贴，就会立即开始同步到 OSS。';
      else if (localImages.length && unresolved > 0) footerNote.textContent = '检测到正文里还有本地图片，但部分图片没有找到对应资源。建议先导入 Markdown 所在目录。';
      else footerNote.textContent = '当前是本地模式，敏感配置仍存放在浏览器本地。多人部署时建议迁移到服务端加密存储。';
    }

    const accountSummary = document.getElementById('account-storage-summary');
    if (accountSummary) accountSummary.textContent = '配置项保存在当前浏览器里；如果部署成多人版，建议迁移为服务端登录 + 加密配置存储。';
  }

  function appendOSSLog(kind, message, url) {
    const log = document.getElementById('oss-upload-log');
    if (!log) return;
    const iconMap = { info: '•', success: '✓', warning: '⚠', error: '✕' };
    const colorMap = { info: '#b7c2d2', success: '#5eead4', warning: '#fbbf24', error: '#fb7185' };
    log.style.display = 'block';
    log.innerHTML += `<div class="settings-log-row"><span style="color:${colorMap[kind] || colorMap.info};font-weight:700;">${iconMap[kind] || iconMap.info}</span><span>${escapeHtml(message)}${url ? ` <a href="${url}" target="_blank" rel="noreferrer">查看</a>` : ''}</span></div>`;
    log.scrollTop = log.scrollHeight;
  }

  function clearOSSLog(note) {
    const log = document.getElementById('oss-upload-log');
    if (!log) return;
    log.style.display = 'block';
    log.innerHTML = '';
    if (note) appendOSSLog('info', note);
  }

  function setAutoSyncState(nextState) {
    Object.assign(AUTO_SYNC_STATE, nextState || {});
    syncSettingsHubStatus();
  }

  function buildLocalImagePlan(md) {
    const localImages = getPendingLocalImageSources(md);
    const uploadQueue = [];
    const missing = [];
    localImages.forEach((src) => {
      const file = resolveImportedFileForSource(src);
      if (file) uploadQueue.push({ src: src, file: file });
      else missing.push(src);
    });
    return { localImages: localImages, uploadQueue: uploadQueue, missing: missing };
  }

  function scheduleAutoImageSync(reason, options, delayMs) {
    clearTimeout(autoSyncTimer);
    autoSyncTimer = setTimeout(() => {
      syncLocalImagesToOSS(reason, options).catch(() => {});
    }, typeof delayMs === 'number' ? delayMs : 300);
  }

  async function syncLocalImagesToOSS(reason, options) {
    const opts = Object.assign({
      showToastOnStart: false,
      showToastOnSuccess: false,
      showToastOnBlocked: false,
      openSettingsOnBlocked: false,
      throwOnBlocked: false,
    }, options || {});

    clearTimeout(autoSyncTimer);
    if (autoSyncInFlight) return autoSyncInFlight;

    autoSyncInFlight = (async function () {
      const ta = document.getElementById('markdown-input');
      if (!ta) return { md: '', uploadedCount: 0, missingCount: 0, failedCount: 0 };
      const md = ta.value || '';
      const plan = buildLocalImagePlan(md);

      if (!plan.localImages.length) {
        if (reason === 'import' || AUTO_SYNC_STATE.phase === 'blocked' || AUTO_SYNC_STATE.phase === 'idle') {
          setAutoSyncState({ phase: 'idle', total: 0, completed: 0, uploaded: 0, failed: 0, missing: 0, message: '' });
        }
        return { md: md, uploadedCount: 0, missingCount: 0, failedCount: 0 };
      }

      const cfg = window.getOSSConfig();
      if (!isCompleteOSSConfig(cfg)) {
        const msg = `检测到 ${plan.localImages.length} 张本地图片，但图床还没有配置完整`;
        setAutoSyncState({ phase: 'blocked', total: plan.localImages.length, completed: 0, uploaded: 0, failed: 0, missing: plan.localImages.length, message: msg });
        if (opts.openSettingsOnBlocked) window.openSettings('media');
        if (opts.showToastOnBlocked) window.showToast(msg);
        if (opts.throwOnBlocked) throw new Error('检测到本地图片，请先在设置中心完成图床配置');
        return { md: md, uploadedCount: 0, missingCount: plan.localImages.length, failedCount: 0 };
      }

      if (!plan.uploadQueue.length) {
        const msg = `检测到 ${plan.localImages.length} 张本地图片，但还没有找到对应的资源文件`;
        setAutoSyncState({ phase: 'blocked', total: plan.localImages.length, completed: 0, uploaded: 0, failed: 0, missing: plan.missing.length, message: msg });
        clearOSSLog('正文里有本地图片，但当前资源库里没有找到可上传的对应文件');
        plan.missing.slice(0, 6).forEach((src) => appendOSSLog('warning', `未找到资源：${src}`));
        if (opts.openSettingsOnBlocked) window.openSettings('media');
        if (opts.showToastOnBlocked) window.showToast(msg);
        if (opts.throwOnBlocked) throw new Error('正文里还有本地图片，但没有找到对应文件。请先导入 Markdown 所在目录或配图。');
        return { md: md, uploadedCount: 0, missingCount: plan.missing.length, failedCount: 0 };
      }

      clearOSSLog(`检测到 ${plan.uploadQueue.length} 张本地图片，开始上传 OSS`);
      if (opts.showToastOnStart) window.showToast(`检测到 ${plan.uploadQueue.length} 张图片，开始上传 OSS…`);
      setAutoSyncState({ phase: 'running', total: plan.uploadQueue.length, completed: 0, uploaded: 0, failed: 0, missing: plan.missing.length, message: `正在上传 0/${plan.uploadQueue.length}` });

      let updatedMd = md;
      let uploadedCount = 0;
      let failedCount = 0;
      for (const item of plan.uploadQueue) {
        appendOSSLog('info', `正在上传 ${item.file.name || item.src}`);
        try {
          const ossUrl = await window.uploadFileToOSS(item.file, cfg);
          updatedMd = replaceExactImageReference(updatedMd, item.src, ossUrl);
          uploadedCount++;
          appendOSSLog('success', `${item.file.name || item.src} 已同步到 OSS`, ossUrl);
        } catch (err) {
          failedCount++;
          appendOSSLog('error', `${item.file.name || item.src} 上传失败：${err.message || String(err)}`);
        }
        setAutoSyncState({
          phase: 'running',
          total: plan.uploadQueue.length,
          completed: uploadedCount + failedCount,
          uploaded: uploadedCount,
          failed: failedCount,
          missing: plan.missing.length,
          message: `正在上传 ${uploadedCount + failedCount}/${plan.uploadQueue.length}`,
        });
      }

      if (updatedMd !== ta.value) {
        ta.value = updatedMd;
        window.immediatePushHistory(updatedMd);
        window.updatePreview();
      }

      const hasBlockingIssues = failedCount > 0 || plan.missing.length > 0;
      const message = uploadedCount
        ? `已自动同步 ${uploadedCount} 张图片${hasBlockingIssues ? `，仍有 ${failedCount + plan.missing.length} 张待处理` : ''}`
        : `本地图片同步未完成，仍有 ${failedCount + plan.missing.length} 张待处理`;
      setAutoSyncState({
        phase: hasBlockingIssues ? 'partial' : 'done',
        total: plan.uploadQueue.length,
        completed: plan.uploadQueue.length,
        uploaded: uploadedCount,
        failed: failedCount,
        missing: plan.missing.length,
        message: message,
      });

      if (uploadedCount && opts.showToastOnSuccess) window.showToast(message);
      else if (!uploadedCount && hasBlockingIssues && opts.showToastOnBlocked) window.showToast(message);

      if (opts.throwOnBlocked && hasBlockingIssues) {
        if (plan.missing.length) throw new Error('正文里还有本地图片，但没有找到对应文件。请先导入 Markdown 所在目录或配图。');
        throw new Error('仍有图片上传失败，请先重试同步后再复制到微信');
      }

      return { md: updatedMd, uploadedCount: uploadedCount, missingCount: plan.missing.length, failedCount: failedCount };
    })();

    try {
      return await autoSyncInFlight;
    } finally {
      autoSyncInFlight = null;
    }
  }

  openSettings = window.openSettings = function (tab) {
    initSettingsHub();
    syncSettingsHubForms();
    syncSettingsHubStatus();
    switchSettingsTab(tab || 'appearance');
    const overlay = document.getElementById(HUB_OVERLAY_ID);
    if (overlay) overlay.classList.add('active');
  };

  closeSettings = window.closeSettings = function () {
    const overlay = document.getElementById(HUB_OVERLAY_ID);
    if (overlay) overlay.classList.remove('active');
  };

  openAISettings = window.openAISettings = function () { window.openSettings('ai'); };
  closeAISettings = window.closeAISettings = function () { window.closeSettings(); };
  openOSSSettings = window.openOSSSettings = function () { window.openSettings('media'); };
  closeOSSSettings = window.closeOSSSettings = function () { window.closeSettings(); };
  window.switchSettingsTab = switchSettingsTab;

  toggleAICustomFields = window.toggleAICustomFields = function () {
    const providerEl = document.getElementById('ai-provider');
    const wrap = document.getElementById('ai-custom-fields');
    const modelWrap = document.getElementById('ai-custom-model-wrap');
    const keyLabel = document.getElementById('ai-api-key-label');
    const keyInput = document.getElementById('ai-api-key');
    if (!providerEl || !wrap || !modelWrap || !keyLabel || !keyInput) return;
    if (providerEl.value === 'zhipu') {
      wrap.style.display = 'none';
      modelWrap.style.display = 'none';
      keyLabel.textContent = '智谱 API Key';
      keyInput.placeholder = '在 open.bigmodel.cn 获取';
    } else {
      wrap.style.display = 'block';
      modelWrap.style.display = 'block';
      keyLabel.textContent = 'API Key';
      keyInput.placeholder = 'sk-...';
    }
  };

  saveAISettings = window.saveAISettings = function () {
    const provider = (document.getElementById('ai-provider') || {}).value || 'zhipu';
    const apiKey = ((document.getElementById('ai-api-key') || {}).value || '').trim();
    const payload = { provider: provider, apiKey: apiKey };
    if (provider === 'custom') {
      payload.apiUrl = ((document.getElementById('ai-api-url') || {}).value || '').trim() || 'https://api.openai.com/v1/chat/completions';
      payload.model = ((document.getElementById('ai-model') || {}).value || '').trim() || 'gpt-4o';
    } else {
      payload.apiUrl = ZHIPU_GLM_API_URL;
      payload.model = ZHIPU_GLM_MODEL;
    }
    localStorage.setItem(AI_STORAGE_KEY, JSON.stringify(payload));
    syncSettingsHubStatus();
    window.showToast('AI 配置已保存');
    return payload;
  };

  persistOSSSettings = window.persistOSSSettings = function (cfg, showSavedToast) {
    localStorage.setItem(OSS_STORAGE_KEY, JSON.stringify(cfg));
    syncSettingsHubStatus();
    if (showSavedToast !== false) window.showToast('图床配置已保存');
    return cfg;
  };

  saveOSSSettings = window.saveOSSSettings = function () {
    const cfg = window.getOSSConfigFromForm();
    const saved = window.persistOSSSettings(cfg, true);
    scheduleAutoImageSync('oss-settings-saved', { showToastOnStart: true, showToastOnSuccess: true, showToastOnBlocked: false }, 120);
    return saved;
  };

  window.saveLocalWorkspaceProfile = function () {
    const payload = {
      displayName: ((document.getElementById('local-display-name') || {}).value || '').trim(),
      email: ((document.getElementById('local-email') || {}).value || '').trim(),
    };
    localStorage.setItem(LOCAL_PROFILE_KEY, JSON.stringify(payload));
    syncSettingsHubStatus();
    window.showToast('本地工作台信息已保存');
  };

  async function importMarkdownBundle(fileList, mode) {
    const files = Array.from(fileList || []);
    let importedMarkdownContent = '';
    if (!files.length) return;
    const markdownFiles = files.filter(isMarkdownFile);
    const imageFiles = files.filter(isImageLikeFile);
    if (!markdownFiles.length && !imageFiles.length) {
      window.showToast('请选择 Markdown 文件或配图资源');
      return;
    }
    const shouldResetAssets = mode === 'folder' || markdownFiles.length > 0;
    registerImportedAssets(imageFiles, { clear: shouldResetAssets });
    if (shouldResetAssets && imageFiles.length === 0) {
      IMPORT_STATE.assets = new Map();
      IMPORT_STATE.assetCount = 0;
    }
    if (markdownFiles.length > 0) {
      const mdFile = markdownFiles[0];
      const content = await mdFile.text();
      importedMarkdownContent = content;
      const ta = document.getElementById('markdown-input');
      ta.value = content;
      window.immediatePushHistory(content);
      IMPORT_STATE.markdownName = mdFile.name;
      IMPORT_STATE.importedAt = new Date().toLocaleString('zh-CN');
      IMPORT_STATE.sourceMode = mode;
      window.updatePreview();
    } else {
      IMPORT_STATE.importedAt = new Date().toLocaleString('zh-CN');
      if (mode !== 'folder') IMPORT_STATE.sourceMode = 'assets';
    }
    syncSettingsHubStatus();
    const summary = [];
    if (markdownFiles.length) summary.push(markdownFiles[0].name);
    if (imageFiles.length) summary.push(`配图 ${imageFiles.length} 张`);
    const importedLabel = `已导入 ${summary.join('，') || '资源文件'}`;
    const shouldTryAutoSync = markdownFiles.length > 0 || imageFiles.length > 0;
    const currentMarkdown = markdownFiles.length > 0 ? importedMarkdownContent : ((document.getElementById('markdown-input') || {}).value || '');
    const pendingImages = getPendingLocalImageSources(currentMarkdown);
    if (!pendingImages.length || !shouldTryAutoSync) {
      window.showToast(importedLabel);
      return;
    }
    if (isCompleteOSSConfig(window.getOSSConfig())) {
      window.showToast(`${importedLabel}，开始同步图片到 OSS…`);
      await syncLocalImagesToOSS('import', { showToastOnStart: false, showToastOnSuccess: true, showToastOnBlocked: true, openSettingsOnBlocked: false });
    } else {
      setAutoSyncState({
        phase: 'blocked',
        total: pendingImages.length,
        completed: 0,
        uploaded: 0,
        failed: 0,
        missing: pendingImages.length,
        message: `已导入正文，检测到 ${pendingImages.length} 张本地图片，等待补全 OSS 配置后自动上传`,
      });
      window.showToast(`${importedLabel}，检测到本地图片，配置图床后会自动上传`);
    }
  }

  window.handleImportBundle = async function (fileList) { await importMarkdownBundle(fileList, 'bundle'); };
  window.handleImportFolder = async function (fileList) { await importMarkdownBundle(fileList, 'folder'); };
  window.triggerImportBundle = function () { initSettingsHub(); const input = document.getElementById('import-bundle-input'); if (input) input.click(); };
  window.triggerImportFolder = function () { initSettingsHub(); const input = document.getElementById('import-folder-input'); if (input) input.click(); };
  window.triggerManualImageUpload = function () { window.openSettings('media'); const input = document.getElementById('oss-file-input'); if (input) input.click(); };

  uploadFileToOSS = window.uploadFileToOSS = async function (file, cfg) {
    const c = cfg || window.getOSSConfig();
    if (!c.accessKey || !c.secretKey || !c.bucket || !c.endpoint) throw new Error('OSS 配置不完整，请先完善设置');
    const prefix = c.prefix ? c.prefix.replace(/\/+$/, '') + '/' : '';
    const ext = (file.name || 'image.bin').split('.').pop();
    const objKey = prefix + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.' + ext;
    const ossDate = new Date().toUTCString();
    const contentType = guessFileContentType(file);
    const canonResource = '/' + c.bucket + '/' + objKey;
    const stringToSign = 'PUT\\n\\n' + contentType + '\\n' + ossDate + '\\n' + 'x-oss-date:' + ossDate + '\\n' + canonResource;
    const sig = await window.hmacSHA1Base64(c.secretKey, stringToSign);
    const auth = 'OSS ' + c.accessKey + ':' + sig;
    const endpoint = c.endpoint.replace(/^https?:\/\//, '');
    const url = 'https://' + c.bucket + '.' + endpoint + '/' + objKey;
    const resp = await fetch(url, { method: 'PUT', headers: { 'Content-Type': contentType, 'x-oss-date': ossDate, Authorization: auth }, body: file });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error('OSS 上传失败：' + resp.status + ' ' + txt.slice(0, 240));
    }
    if (c.customDomain) return c.customDomain.replace(/\/+$/, '') + '/' + objKey;
    return url;
  };

  handleOSSUpload = window.handleOSSUpload = async function (files) {
    const list = Array.from(files || []).filter(isImageLikeFile);
    if (!list.length) return;
    initSettingsHub();
    window.openSettings('media');
    clearOSSLog(`准备上传 ${list.length} 张图片`);
    registerImportedAssets(list, { clear: false });
    const currentCfg = window.getOSSConfigFromForm();
    window.persistOSSSettings(currentCfg, false);
    const ta = document.getElementById('markdown-input');
    let md = ta.value;
    let replaced = 0;
    let uploaded = 0;
    for (const file of list) {
      appendOSSLog('info', `正在上传 ${file.name}`);
      try {
        const ossUrl = await window.uploadFileToOSS(file, currentCfg);
        uploaded++;
        const newMd = replaceImageReferencesByFileName(md, file.name, ossUrl);
        if (newMd !== md) {
          replaced++;
          md = newMd;
          appendOSSLog('success', `${file.name} 上传成功，并已替换正文里的同名引用`, ossUrl);
        } else {
          appendOSSLog('warning', `${file.name} 上传成功，但正文里没有找到同名引用`, ossUrl);
        }
      } catch (err) {
        appendOSSLog('error', `${file.name} 上传失败：${err.message || String(err)}`);
      }
    }
    if (md !== ta.value) {
      ta.value = md;
      window.immediatePushHistory(md);
      window.updatePreview();
    }
    syncSettingsHubStatus();
    window.showToast(replaced ? `已上传 ${uploaded} 张图片，并替换 ${replaced} 处引用` : `已上传 ${uploaded} 张图片`);
  };

  async function ensureLocalImagesUploadedBeforeCopy() {
    return await syncLocalImagesToOSS('copy', {
      showToastOnStart: false,
      showToastOnSuccess: false,
      showToastOnBlocked: false,
      openSettingsOnBlocked: true,
      throwOnBlocked: true,
    });
  }

  function setCopyButtonState(label, busy) {
    const btn = document.getElementById('btn-copy');
    if (!btn) return;
    btn.disabled = !!busy;
    btn.style.opacity = busy ? '0.82' : '';
    btn.textContent = label;
  }

  copyForWeChat = window.copyForWeChat = async function () {
    const btn = document.getElementById('btn-copy');
    if (!btn) return;
    try {
      setCopyButtonState('检查图片…', true);
      const prepared = await ensureLocalImagesUploadedBeforeCopy();
      const overrides = window.getPreviewStyleOverrides();
      window.__tailImgSrc = '';
      window.__tailImgAlt = '';
      let html = window.renderDocument(prepared.md, overrides);
      if (showFixedFooter) html += window.renderFixedFooter();
      const fullHtml = '<section style="background:' + CONFIG.bg + ';padding:16px;margin:0;">' + html + '</section>';
      setCopyButtonState(prepared.uploadedCount ? '同步完成，正在复制…' : '正在复制…', true);
      if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        const blob = new Blob([fullHtml], { type: 'text/html' });
        await navigator.clipboard.write([new ClipboardItem({ 'text/html': blob })]);
      } else {
        const temp = document.createElement('textarea');
        temp.value = fullHtml;
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        document.body.removeChild(temp);
      }
      btn.textContent = '已复制 ✓';
      btn.classList.add('copied');
      btn.disabled = false;
      btn.style.opacity = '';
      window.showToast(prepared.uploadedCount ? `已自动同步 ${prepared.uploadedCount} 张图片，并复制到微信` : '已复制到剪贴板，可直接粘贴到微信编辑器');
      setTimeout(() => { btn.textContent = '复制到微信'; btn.classList.remove('copied'); }, 2000);
    } catch (err) {
      btn.disabled = false;
      btn.style.opacity = '';
      btn.textContent = '复制到微信';
      window.showToast(err.message || '复制失败');
    }
  };

  updatePreview = window.updatePreview = function () {
    baseUpdatePreview();
    syncSettingsHubStatus();
    scheduleAutoImageSync('preview-update', { showToastOnStart: false, showToastOnSuccess: false, showToastOnBlocked: false }, 650);
  };

  initSettingsHub();
  syncSettingsHubStatus();
})();
