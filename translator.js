// ==UserScript==
// @name         Discord Translator
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Real-time bidirectional translation overlay for Discord with AI support
// @author       Noah Zielinski
// @match        https://discord.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      translate.googleapis.com
// @connect      api.openai.com
// @connect      api.anthropic.com
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // =====================================================================
    // SETTINGS
    // =====================================================================
    const S = {
        incomingLang: () => GM_getValue('incomingLang', 'en'),
        outgoingLang: () => GM_getValue('outgoingLang', 'es'),
        viewDouble: () => GM_getValue('viewDouble', false),
        disableIncoming: () => GM_getValue('disableIncoming', false),
        disableOutgoing: () => GM_getValue('disableOutgoing', false),
        aiEnabled: () => GM_getValue('aiEnabled', false),
        aiProvider: () => GM_getValue('aiProvider', 'openai'),
        aiModel: () => GM_getValue('aiModel', 'gpt-4o-mini'),
        aiApiKey: () => GM_getValue('aiApiKey', ''),
        sessionTokens: () => GM_getValue('sessionTokens', 0),
        totalTokensIn: () => GM_getValue('totalTokensIn', 0),
        totalTokensOut: () => GM_getValue('totalTokensOut', 0),
        uiX: () => GM_getValue('uiX', null),
        uiY: () => GM_getValue('uiY', null),
    };
    const save = (k, v) => GM_setValue(k, v);

    // =====================================================================
    // LANGUAGE LIST
    // =====================================================================
    const LANGS = {
        'en':'English','es':'Spanish','fr':'French','de':'German','it':'Italian',
        'pt':'Portuguese','ru':'Russian','ja':'Japanese','ko':'Korean',
        'zh':'Chinese (Simplified)','zh-TW':'Chinese (Traditional)',
        'ar':'Arabic','hi':'Hindi','nl':'Dutch','pl':'Polish','sv':'Swedish',
        'tr':'Turkish','vi':'Vietnamese','th':'Thai','id':'Indonesian',
        'uk':'Ukrainian','cs':'Czech','ro':'Romanian','el':'Greek',
        'hu':'Hungarian','fi':'Finnish','he':'Hebrew','da':'Danish','no':'Norwegian',
    };

    const AI_MODELS = {
        openai:    ['gpt-4o-mini','gpt-4o','gpt-4-turbo','gpt-3.5-turbo'],
        anthropic: ['claude-haiku-4-5-20251001','claude-sonnet-4-6','claude-opus-4-6'],
    };

    // =====================================================================
    // UI STRINGS  (English source — translated into incoming lang at runtime)
    // =====================================================================
    const UI_EN = {
        title:           'Discord Translator',
        inLangLabel:     'Incoming Language',
        outLangLabel:    'Outgoing Language',
        viewDouble:      'View Double Translation',
        disableIncoming: 'Disable Incoming Translations',
        disableOutgoing: 'Disable Outgoing Translations',
        aiTranslation:   'AI Translation',
        provider:        'Provider',
        model:           'Model',
        apiKey:          'API Key',
        sessionTokens:   'Session tokens',
        statusReady:     'Translator ready',
        collapseBtn:     '▼',
        expandBtn:       '▶',
    };
    let UI = { ...UI_EN };

    const TOOLTIPS_EN = {
        inLangLabel:
            'The language YOU speak. Incoming messages from others are translated INTO this language. ' +
            'The UI itself will also switch to this language when you change it.',
        outLangLabel:
            'The language your messages will be SENT in. When you type and hit send, your message ' +
            'is automatically translated from your incoming language into this one before it reaches the server.',
        viewDouble:
            'After sending a message, shows a small green badge below it with a back-translation: ' +
            'your message translated to the outgoing language (what was sent), then translated back ' +
            'to your incoming language — so you can see what recipients actually read.',
        disableIncoming:
            'Stops translating messages FROM others. Their messages appear exactly as sent, ' +
            'with no translation badge appended. Your outgoing translation is unaffected.',
        disableOutgoing:
            'Stops translating YOUR outgoing messages. What you type is sent as-is to the server. ' +
            'Incoming translations from others are unaffected.',
        aiTranslation:
            'Use an AI language model (OpenAI or Anthropic) instead of Google Translate. ' +
            'AI translations are often more natural and context-aware. ' +
            'Requires an API key. Token usage is tracked per session; ' +
            'a new session starts automatically at 50 000 tokens.',
        provider:
            'Choose which AI provider to use: OpenAI (GPT models) or Anthropic (Claude models). ' +
            'Your API key must match the selected provider.',
        model:
            'The specific AI model to call for translations. Smaller models (gpt-4o-mini, claude-haiku) ' +
            'cost fewer tokens. Larger models may produce more accurate or nuanced translations.',
        apiKey:
            '\nYour secret API key for the selected provider. ' +
            '\nStored locally in Tampermonkey storage — sent only to the provider\'s API, nowhere else.  Don’t expose it publicly.' +
            '\n\n🔑 OpenAI' +
            '\n\tGo to: https://platform.openai.com/' +
            '\n\tLog in / create account' +
            '\n\tNavigate to API Keys' +
            '\n\tClick Create new secret key' +
            '\n\tCopy it (you won’t see it again)' +
            '\n\t' +
            '\n\tNotes:' +
            '\n\t\tStarts with sk-...' +
            '\n\t\tYou need billing set up or credits' +
            '\n\n🔑 Anthropic' +
            '\n\tGo to: https://console.anthropic.com/' +
            '\n\tLog in' +
            '\n\tGo to API Keys' +
            '\n\tCreate key → copy' +
            '\n' +
            '\n\tNotes:' +
            '\n\t\tStarts with sk-ant-...' +
            '\n\t\tRequires billing enabled'
    };
    let TOOLTIPS = { ...TOOLTIPS_EN };

    // =====================================================================
    // TRANSLATION ENGINE
    // =====================================================================
    function gTranslate(text, from, to) {
        return new Promise((resolve, reject) => {
            if (!text?.trim() || from === to) return resolve(text);
            const sl = (!from || from === 'auto') ? 'auto' : from;
            const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;
            GM_xmlhttpRequest({
                method: 'GET', url,
                onload(r) {
                    try {
                        const d = JSON.parse(r.responseText);
                        let out = '';
                        if (d[0]) d[0].forEach(p => { if (p[0]) out += p[0]; });
                        resolve(out || text);
                    } catch(e) { reject(e); }
                },
                onerror: reject,
            });
        });
    }

    function aiTranslate(text, from, to) {
        if (!S.aiApiKey()) {
            showToast('⚠ No AI API key — falling back to Google Translate');
            return gTranslate(text, from, to);
        }
        const srcName = LANGS[from] || from || 'auto-detected';
        const tgtName = LANGS[to] || to;
        const prompt = (!from || from === 'auto')
            ? `Translate to ${tgtName}. Return ONLY the translation, nothing else:\n${text}`
            : `Translate from ${srcName} to ${tgtName}. Return ONLY the translation, nothing else:\n${text}`;
        return S.aiProvider() === 'anthropic' ? anthropicCall(prompt, text) : openaiCall(prompt, text);
    }

    function openaiCall(prompt, fallback) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST', url: 'https://api.openai.com/v1/chat/completions',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${S.aiApiKey()}` },
                data: JSON.stringify({ model: S.aiModel() || 'gpt-4o-mini',
                    messages: [{ role: 'user', content: prompt }], max_tokens: 500, temperature: 0.2 }),
                onload(r) {
                    try {
                        const d = JSON.parse(r.responseText);
                        if (d.error) { showToast(`AI Error: ${d.error.message}`); return resolve(fallback); }
                        if (d.usage) addTokens(d.usage.prompt_tokens || 0, d.usage.completion_tokens || 0);
                        resolve(d.choices?.[0]?.message?.content?.trim() || fallback);
                    } catch(e) { reject(e); }
                },
                onerror: reject,
            });
        });
    }

    function anthropicCall(prompt, fallback) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST', url: 'https://api.anthropic.com/v1/messages',
                headers: { 'Content-Type': 'application/json', 'x-api-key': S.aiApiKey(),
                    'anthropic-version': '2023-06-01',
                    'anthropic-dangerous-direct-browser-access': 'true' },
                data: JSON.stringify({ model: S.aiModel() || 'claude-haiku-4-5-20251001',
                    max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
                onload(r) {
                    try {
                        const d = JSON.parse(r.responseText);
                        if (d.error) { showToast(`AI Error: ${d.error.message}`); return resolve(fallback); }
                        if (d.usage) addTokens(d.usage.input_tokens || 0, d.usage.output_tokens || 0);
                        resolve(d.content?.[0]?.text?.trim() || fallback);
                    } catch(e) { reject(e); }
                },
                onerror: reject,
            });
        });
    }

    async function translate(text, from, to) {
        if (!text?.trim()) return text;
        if (from && from !== 'auto' && from === to) return text;
        try {
            return S.aiEnabled() ? await aiTranslate(text, from, to) : await gTranslate(text, from, to);
        } catch(e) {
            console.error('[DT] Translation error:', e);
            return text;
        }
    }

    // =====================================================================
    // TOKEN TRACKING
    // =====================================================================
    function addTokens(inTok, outTok) {
        const ns = S.sessionTokens() + inTok + outTok;
        save('sessionTokens', ns);
        save('totalTokensIn', S.totalTokensIn() + inTok);
        save('totalTokensOut', S.totalTokensOut() + outTok);
        refreshTokenDisplay();
        if (ns >= 50000) {
            save('sessionTokens', 0);
            showToast('🔄 Token session reset (50k reached)');
            refreshTokenDisplay();
        }
    }

    // =====================================================================
    // OUTGOING FETCH INTERCEPTOR
    // =====================================================================
    // Queue of back-translation promises keyed by the translated text
    const doubleQueue = new Map();

    const _origFetch = window.fetch.bind(window);
    window.fetch = async function (...args) {
        let [resource, config] = args;
        const url = typeof resource === 'string' ? resource : resource?.url || '';
        const isMsg = (
            !S.disableOutgoing() &&
            (config?.method || '').toUpperCase() === 'POST' &&
            /\/api\/v\d+\/channels\/\d+\/messages$/.test(url)
        );
        if (isMsg) {
            try {
                const body = JSON.parse(config.body);
                if (body?.content?.trim()) {
                    const original = body.content;
                    const translated = await translate(original, S.incomingLang(), S.outgoingLang());
                    body.content = translated;
                    config = { ...config, body: JSON.stringify(body) };
                    args = [resource, config];

                    if (S.viewDouble()) {
                        // Fire back-translation immediately; store promise keyed by translated text
                        const backPromise = translate(translated, S.outgoingLang(), S.incomingLang());
                        doubleQueue.set(translated, backPromise);
                        // Safety cleanup after 30 s if message never appears in DOM
                        setTimeout(() => doubleQueue.delete(translated), 30000);
                    }
                }
            } catch(_) { /* let request through unchanged */ }
        }
        return _origFetch(...args);
    };

    // =====================================================================
    // OUTGOING XHR INTERCEPTOR
    // =====================================================================
    const _origXHROpen = XMLHttpRequest.prototype.open;
    const _origXHRSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._dt_method = method;
        this._dt_url = url;
        return _origXHROpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = async function(body) {
        const isMsg = (
            !S.disableOutgoing() &&
            (this._dt_method || '').toUpperCase() === 'POST' &&
            /\/api\/v\d+\/channels\/\d+\/messages$/.test(this._dt_url || '')
        );
        if (isMsg) {
            try {
                const parsed = JSON.parse(body);
                if (parsed?.content?.trim()) {
                    const original = parsed.content;
                    const translated = await translate(original, S.incomingLang(), S.outgoingLang());
                    parsed.content = translated;
                    body = JSON.stringify(parsed);

                    if (S.viewDouble()) {
                        const backPromise = translate(translated, S.outgoingLang(), S.incomingLang());
                        doubleQueue.set(translated, backPromise);
                        setTimeout(() => doubleQueue.delete(translated), 30000);
                    }
                }
            } catch(_) { /* let request through unchanged */ }
        }
        return _origXHRSend.call(this, body);
    };

    // =====================================================================
    // INCOMING + DOUBLE-TRANSLATION OBSERVER
    // =====================================================================
    const _seenEls = new WeakSet();

    function startObserver() {
        const obs = new MutationObserver(muts => {
            for (const mut of muts) {
                for (const node of mut.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    processNode(node);
                }
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    function processNode(root) {
        const sel = '[class*="messageContent"],[class*="message-content"],[id*="message-content"]';
        const hits = root.matches?.(sel) ? [root] : [...(root.querySelectorAll?.(sel) || [])];
        hits.forEach(el => {
            if (_seenEls.has(el)) return;
            _seenEls.add(el);
            // Try to attach a double-translation badge (if we sent this message)
            tryAttachDouble(el);
            // Translate incoming messages from others
            if (!S.disableIncoming()) translateIncomingEl(el);
        });
    }

    async function tryAttachDouble(el) {
        if (!S.viewDouble()) return;
        const clone = el.cloneNode(true);
        clone.querySelectorAll('[data-dt-badge]').forEach(e => e.remove());
        const text = clone.textContent?.trim();
        if (!text || !doubleQueue.has(text)) return;

        const backPromise = doubleQueue.get(text);
        doubleQueue.delete(text);
        try {
            const back = await backPromise;
            if (!back || back.trim() === text) return;
            const badge = makeBadge(back, '#23a55a', '↩');
            el.appendChild(badge);
        } catch(_) {}
    }

    async function translateIncomingEl(el) {
        const clone = el.cloneNode(true);
        clone.querySelectorAll('img,[class*="emoji"],[data-type="emoji"],[data-dt-badge]').forEach(e => e.remove());
        const text = clone.textContent?.trim();
        if (!text || text.length < 2) return;
        try {
            const translated = await translate(text, 'auto', S.incomingLang());
            if (!translated || translated.trim() === text.trim()) return;
            el.appendChild(makeBadge(translated, '#5865f2', '🌐'));
        } catch(_) {}
    }

    function makeBadge(text, accentColor, icon) {
        const badge = document.createElement('span');
        badge.setAttribute('data-dt-badge', 'true');
        badge.style.cssText = [
            'display:block', 'margin-top:3px', 'font-size:0.82em',
            'color:#b5bac1', 'font-style:italic', 'padding:2px 6px',
            `border-left:2px solid ${accentColor}`, 'opacity:0.85',
        ].join(';');
        badge.innerHTML = `<span style="color:${accentColor};opacity:.75;margin-right:4px;">${icon}</span>${escHtml(text)}`;
        return badge;
    }

    // =====================================================================
    // UI STRING TRANSLATION  (translates entire UI into the incoming language)
    // =====================================================================
    async function translateUIStrings(lang) {
        if (lang === 'en') {
            UI = { ...UI_EN };
            TOOLTIPS = { ...TOOLTIPS_EN };
            applyUIStrings();
            return;
        }
        const uiKeys = Object.keys(UI_EN);
        const tipKeys = Object.keys(TOOLTIPS_EN);
        const allSrc = [...uiKeys.map(k => UI_EN[k]), ...tipKeys.map(k => TOOLTIPS_EN[k])];
        const results = await Promise.all(allSrc.map(t => gTranslate(t, 'en', lang).catch(() => t)));
        uiKeys.forEach((k, i) => { UI[k] = results[i] || UI_EN[k]; });
        tipKeys.forEach((k, i) => { TOOLTIPS[k] = results[uiKeys.length + i] || TOOLTIPS_EN[k]; });
        applyUIStrings();
    }

    function applyUIStrings() {
        // Update labels and buttons
        document.querySelectorAll('[data-dt-str]').forEach(el => {
            const v = UI[el.dataset.dtStr];
            if (v !== undefined) el.textContent = v;
        });
        // Update tooltip content cache
        document.querySelectorAll('[data-dt-tip]').forEach(el => {
            const v = TOOLTIPS[el.dataset.dtTip];
            if (v !== undefined) el.dataset.dtTipContent = v;
        });
        refreshTokenDisplay();
    }

    // =====================================================================
    // TOOLTIP SYSTEM
    // =====================================================================
    let _tipEl = null;
    let _tipTimer = null;

    function setupTooltips() {
        _tipEl = document.createElement('div');
        _tipEl.id = 'dt-tooltip';
        _tipEl.style.cssText = [
            'position:fixed', 'z-index:99999999', 'max-width:230px',
            'background:#111214', 'color:#dbdee1', 'font-size:11.5px', 'line-height:1.55',
            'padding:8px 11px', 'border-radius:8px',
            'border:1px solid #3a3c40', 'box-shadow:0 6px 24px rgba(0,0,0,.5)',
            'pointer-events:none', 'opacity:0', 'transition:opacity .15s',
            'white-space:pre-wrap', 'font-family:"gg sans",Whitney,sans-serif', 'display:none',
        ].join(';');
        document.body.appendChild(_tipEl);

        document.addEventListener('mouseover', e => {
            const trig = e.target.closest('[data-dt-tip]');
            if (!trig) return;
            const content = trig.dataset.dtTipContent || TOOLTIPS[trig.dataset.dtTip] || '';
            if (!content) return;
            clearTimeout(_tipTimer);
            _tipTimer = setTimeout(() => positionTip(trig, content), 380);
        });

        document.addEventListener('mouseout', e => {
            if (e.target.closest('[data-dt-tip]')) {
                clearTimeout(_tipTimer);
                _tipEl.style.opacity = '0';
                setTimeout(() => { if (_tipEl.style.opacity === '0') _tipEl.style.display = 'none'; }, 160);
            }
        });
    }

    function positionTip(anchor, content) {
        _tipEl.textContent = content;
        _tipEl.style.display = 'block';
        _tipEl.style.opacity = '0';
        // Need to measure after display:block
        requestAnimationFrame(() => {
            const ar = anchor.getBoundingClientRect();
            const tw = _tipEl.offsetWidth;
            const th = _tipEl.offsetHeight;
            const vw = window.innerWidth;
            const vh = window.innerHeight;

            let left = ar.left;
            let top = ar.bottom + 6;
            if (top + th > vh - 8) top = ar.top - th - 6;
            if (left + tw > vw - 8) left = vw - tw - 8;
            if (left < 8) left = 8;

            _tipEl.style.left = left + 'px';
            _tipEl.style.top = top + 'px';
            _tipEl.style.opacity = '1';
        });
    }

    // =====================================================================
    // BOUNDS-CONFINED DRAG
    // =====================================================================
    function makeDraggable(panel, handle, xKey, yKey) {
        let dragging = false, sx, sy, sl, st;

        handle.addEventListener('mousedown', e => {
            if (e.target.closest('button,select,input,label')) return;
            dragging = true;
            sx = e.clientX; sy = e.clientY;
            sl = panel.offsetLeft; st = panel.offsetTop;
            handle.style.cursor = 'grabbing';
            e.preventDefault();
        });

        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            const maxX = Math.max(0, window.innerWidth - panel.offsetWidth);
            const maxY = Math.max(0, window.innerHeight - panel.offsetHeight);
            const nx = Math.max(0, Math.min(sl + e.clientX - sx, maxX));
            const ny = Math.max(0, Math.min(st + e.clientY - sy, maxY));
            panel.style.left = nx + 'px';
            panel.style.top = ny + 'px';
            panel.style.right = 'auto';
            if (xKey) save(xKey, nx);
            if (yKey) save(yKey, ny);
        });

        document.addEventListener('mouseup', () => {
            dragging = false;
            handle.style.cursor = 'grab';
        });
    }

    // =====================================================================
    // TOAST
    // =====================================================================
    function showToast(msg) {
        const t = document.createElement('div');
        t.style.cssText = [
            'position:fixed', 'bottom:90px', 'left:50%', 'transform:translateX(-50%)',
            'background:#23a55a', 'color:#fff', 'padding:8px 16px', 'border-radius:20px',
            'font-size:13px', 'z-index:9999999', 'pointer-events:none',
            'font-family:"gg sans",Whitney,sans-serif', 'box-shadow:0 4px 16px rgba(0,0,0,.4)',
            'animation:dtFadeIn .2s ease',
        ].join(';');
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 3000);
    }

    // =====================================================================
    // DOM HELPERS
    // =====================================================================
    function h(tag, css, attrs = {}) {
        const el = document.createElement(tag);
        if (css) el.style.cssText = css;
        Object.entries(attrs).forEach(([k, v]) => {
            if (k === 'html') el.innerHTML = v; else el[k] = v;
        });
        return el;
    }

    function escHtml(s) {
        const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
    }

    // =====================================================================
    // WIDGET FACTORIES
    // =====================================================================
    function makeToggle(id, strKey, tipKey, value, color = '#5865f2') {
        const row = h('div',
            'display:flex;align-items:center;justify-content:space-between;gap:10px;');
        if (tipKey) { row.dataset.dtTip = tipKey; row.dataset.dtTipContent = TOOLTIPS[tipKey] || ''; }

        const lbl = h('span', 'font-size:13px;color:#dbdee1;flex:1;line-height:1.3;');
        lbl.dataset.dtStr = strKey;
        lbl.textContent = UI[strKey] || strKey;

        const track = h('div',
            `width:38px;height:20px;border-radius:10px;background:${value ? color : '#4e5058'};` +
            'position:relative;cursor:pointer;transition:background .2s;flex-shrink:0;');
        track.id = id;
        track.dataset.checked = value ? 'true' : 'false';

        const thumb = h('div',
            `position:absolute;top:2px;left:${value ? '18px' : '2px'};` +
            'width:16px;height:16px;border-radius:50%;background:#fff;transition:left .18s;');
        track.appendChild(thumb);

        track.addEventListener('click', () => {
            const next = track.dataset.checked !== 'true';
            track.dataset.checked = next;
            track.style.background = next ? color : '#4e5058';
            thumb.style.left = next ? '18px' : '2px';
            track.dispatchEvent(new CustomEvent('dt:change', { detail: next, bubbles: true }));
        });

        row.appendChild(lbl);
        row.appendChild(track);
        return row;
    }

    function makeSelect(id, strKey, tipKey, options, selected) {
        const wrap = h('div', 'display:flex;flex-direction:column;gap:5px;');
        if (tipKey) { wrap.dataset.dtTip = tipKey; wrap.dataset.dtTipContent = TOOLTIPS[tipKey] || ''; }

        const lbl = h('label',
            'font-size:10px;font-weight:700;color:#87898c;text-transform:uppercase;letter-spacing:.6px;');
        lbl.dataset.dtStr = strKey;
        lbl.textContent = UI[strKey] || strKey;

        const sel = h('select',
            'background:#111214;color:#dbdee1;border:1px solid #3a3c40;border-radius:6px;' +
            'padding:5px 8px;font-size:12px;cursor:pointer;outline:none;');
        sel.id = id;
        options.forEach(([val, txt]) => {
            const o = document.createElement('option');
            o.value = val; o.textContent = txt;
            if (val === selected) o.selected = true;
            sel.appendChild(o);
        });
        wrap.appendChild(lbl);
        wrap.appendChild(sel);
        return wrap;
    }

    // =====================================================================
    // MAIN PANEL
    // =====================================================================
    function buildPanel() {
        const { x, y } = { x: S.uiX(), y: S.uiY() };
        const panel = h('div',
            `position:fixed;${x !== null ? `left:${x}px;top:${y}px` : 'right:20px;top:76px'};` +
            'width:292px;background:#2b2d31;border:1px solid #1e1f22;border-radius:12px;' +
            'box-shadow:0 8px 40px rgba(0,0,0,.6);z-index:9999999;' +
            'font-family:"gg sans",Whitney,"Helvetica Neue",Arial,sans-serif;color:#dbdee1;'
        );
        panel.id = 'discord-translator-panel';

        // ── Header ──────────────────────────────────────────────────────
        const hdr = h('div',
            'padding:11px 14px;background:#1e1f22;border-radius:12px 12px 0 0;' +
            'display:flex;align-items:center;justify-content:space-between;cursor:grab;' +
            'border-bottom:1px solid #111214;');

        const titleRow = h('div', 'display:flex;align-items:center;gap:7px;');
        titleRow.appendChild(h('span', 'font-size:15px;', { html: '🌐' }));
        const titleText = h('span', 'font-weight:700;font-size:13px;color:#fff;letter-spacing:.2px;');
        titleText.dataset.dtStr = 'title';
        titleText.textContent = UI.title;
        titleRow.appendChild(titleText);

        const colBtn = h('button',
            'background:none;border:none;color:#87898c;cursor:pointer;font-size:13px;' +
            'padding:2px 4px;line-height:1;border-radius:4px;transition:color .15s;');
        colBtn.dataset.dtStr = 'collapseBtn';
        colBtn.textContent = UI.collapseBtn;

        hdr.appendChild(titleRow);
        hdr.appendChild(colBtn);

        // ── Body ────────────────────────────────────────────────────────
        const body = h('div', 'padding:14px;display:flex;flex-direction:column;gap:10px;');

        const langEntries = Object.entries(LANGS);
        body.appendChild(makeSelect('dt-in-lang', 'inLangLabel', 'inLangLabel', langEntries, S.incomingLang()));
        body.appendChild(makeSelect('dt-out-lang', 'outLangLabel', 'outLangLabel', langEntries, S.outgoingLang()));

        body.appendChild(h('div', 'height:1px;background:#3a3c40;margin:2px 0;'));

        body.appendChild(makeToggle('dt-tgl-double', 'viewDouble', 'viewDouble', S.viewDouble()));
        body.appendChild(makeToggle('dt-tgl-no-in', 'disableIncoming', 'disableIncoming', S.disableIncoming(), '#ed4245'));
        body.appendChild(makeToggle('dt-tgl-no-out', 'disableOutgoing', 'disableOutgoing', S.disableOutgoing(), '#ed4245'));
        body.appendChild(makeToggle('dt-tgl-ai', 'aiTranslation', 'aiTranslation', S.aiEnabled(), '#23a55a'));

        // ── AI Sub-panel ─────────────────────────────────────────────────
        const aiPanel = h('div',
            `display:${S.aiEnabled() ? 'flex' : 'none'};flex-direction:column;gap:8px;` +
            'padding:10px;background:#1a1b1e;border-radius:8px;border:1px solid #2e3035;');

        const provEntries = [['openai','OpenAI'],['anthropic','Anthropic']];
        const modelEntries = AI_MODELS[S.aiProvider()].map(m => [m, m]);
        aiPanel.appendChild(makeSelect('dt-ai-prov', 'provider', 'provider', provEntries, S.aiProvider()));
        aiPanel.appendChild(makeSelect('dt-ai-model', 'model', 'model', modelEntries, S.aiModel()));

        // API key field
        const keyWrap = h('div', 'display:flex;flex-direction:column;gap:5px;');
        keyWrap.dataset.dtTip = 'apiKey';
        keyWrap.dataset.dtTipContent = TOOLTIPS.apiKey;
        const keyLbl = h('label',
            'font-size:10px;font-weight:700;color:#87898c;text-transform:uppercase;letter-spacing:.6px;');
        keyLbl.dataset.dtStr = 'apiKey';
        keyLbl.textContent = UI.apiKey;
        const keyInput = h('input',
            'background:#111214;color:#dbdee1;border:1px solid #3a3c40;border-radius:6px;' +
            'padding:5px 8px;font-size:12px;outline:none;width:100%;box-sizing:border-box;');
        keyInput.id = 'dt-ai-key';
        keyInput.type = 'password';
        keyInput.placeholder = 'sk-… or sk-ant-…';
        keyInput.value = S.aiApiKey();
        keyInput.addEventListener('change', () => save('aiApiKey', keyInput.value));
        keyInput.addEventListener('blur', () => save('aiApiKey', keyInput.value));
        keyWrap.appendChild(keyLbl);
        keyWrap.appendChild(keyInput);
        aiPanel.appendChild(keyWrap);

        // Token meter
        const meterWrap = h('div',
            'background:#111214;border-radius:6px;padding:8px;font-size:11px;color:#87898c;');
        meterWrap.id = 'dt-token-wrap';
        meterWrap.innerHTML = buildTokenHTML();
        aiPanel.appendChild(meterWrap);

        body.appendChild(aiPanel);

        // ── Status bar ───────────────────────────────────────────────────
        const statusBar = h('div',
            'font-size:10px;color:#87898c;text-align:center;padding:4px 0 2px;' +
            'border-top:1px solid #1e1f22;');
        statusBar.id = 'dt-status';
        statusBar.dataset.dtStr = 'statusReady';
        statusBar.textContent = UI.statusReady;
        body.appendChild(statusBar);

        panel.appendChild(hdr);
        panel.appendChild(body);
        document.body.appendChild(panel);
        makeDraggable(panel, hdr, 'uiX', 'uiY');

        // ── Collapse ─────────────────────────────────────────────────────
        let collapsed = false;
        colBtn.addEventListener('click', () => {
            collapsed = !collapsed;
            body.style.display = collapsed ? 'none' : 'flex';
            colBtn.dataset.dtStr = collapsed ? 'expandBtn' : 'collapseBtn';
            colBtn.textContent = collapsed ? UI.expandBtn : UI.collapseBtn;
            panel.style.borderRadius = collapsed ? '12px' : '12px 12px 0 0';
        });

        // ── Language select events ────────────────────────────────────────
        panel.querySelector('#dt-in-lang').addEventListener('change', function () {
            save('incomingLang', this.value);
            translateUIStrings(this.value); // translate the whole UI
        });
        panel.querySelector('#dt-out-lang').addEventListener('change', function () {
            save('outgoingLang', this.value);
        });

        // ── Toggle events ─────────────────────────────────────────────────
        panel.querySelector('#dt-tgl-double').addEventListener('dt:change', e => {
            save('viewDouble', e.detail);
            setStatus(e.detail ? 'Double translation ON' : 'Double translation OFF');
        });
        panel.querySelector('#dt-tgl-no-in').addEventListener('dt:change', e => {
            save('disableIncoming', e.detail);
            setStatus(e.detail ? 'Incoming OFF' : 'Incoming ON');
        });
        panel.querySelector('#dt-tgl-no-out').addEventListener('dt:change', e => {
            save('disableOutgoing', e.detail);
            setStatus(e.detail ? 'Outgoing OFF' : 'Outgoing ON');
        });
        panel.querySelector('#dt-tgl-ai').addEventListener('dt:change', e => {
            save('aiEnabled', e.detail);
            aiPanel.style.display = e.detail ? 'flex' : 'none';
            setStatus(e.detail ? 'AI Translation ON' : 'Using Google Translate');
        });

        // ── AI sub-panel events ───────────────────────────────────────────
        panel.querySelector('#dt-ai-prov').addEventListener('change', function () {
            save('aiProvider', this.value);
            const modelSel = panel.querySelector('#dt-ai-model');
            const newModels = AI_MODELS[this.value] || [];
            modelSel.innerHTML = '';
            newModels.forEach(m => {
                const o = document.createElement('option');
                o.value = m; o.textContent = m;
                modelSel.appendChild(o);
            });
            modelSel.value = newModels[0];
            save('aiModel', newModels[0]);
        });
        panel.querySelector('#dt-ai-model').addEventListener('change', function () {
            save('aiModel', this.value);
        });
    }

    // =====================================================================
    // TOKEN HTML
    // =====================================================================
    function buildTokenHTML() {
        const sess = S.sessionTokens();
        const inTok = S.totalTokensIn();
        const outTok = S.totalTokensOut();
        const pct = Math.min((sess / 50000) * 100, 100).toFixed(1);
        const col = sess > 40000 ? '#ed4245' : sess > 25000 ? '#f0b132' : '#5865f2';
        const lbl = escHtml(UI.sessionTokens || UI_EN.sessionTokens);
        return `
            <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                <span>${lbl}</span>
                <span style="color:#dbdee1;font-weight:600;">${sess.toLocaleString()} / 50,000</span>
            </div>
            <div style="height:5px;background:#2b2d31;border-radius:3px;overflow:hidden;margin-bottom:6px;">
                <div style="height:100%;width:${pct}%;background:${col};border-radius:3px;transition:width .3s;"></div>
            </div>
            <div style="display:flex;justify-content:space-between;">
                <span>↓ In: <strong style="color:#23a55a;">${inTok.toLocaleString()}</strong></span>
                <span>↑ Out: <strong style="color:#f0b132;">${outTok.toLocaleString()}</strong></span>
                <span>Total: <strong style="color:#dbdee1;">${(inTok + outTok).toLocaleString()}</strong></span>
            </div>`;
    }

    function refreshTokenDisplay() {
        const w = document.getElementById('dt-token-wrap');
        if (w) w.innerHTML = buildTokenHTML();
    }

    function setStatus(msg) {
        const s = document.getElementById('dt-status');
        if (s) {
            s.textContent = msg;
            setTimeout(() => { s.textContent = UI.statusReady; }, 2500);
        }
    }

    // =====================================================================
    // GLOBAL STYLES
    // =====================================================================
    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            #discord-translator-panel *, #dt-tooltip { box-sizing: border-box; }
            @keyframes dtFadeIn {
                from { opacity: 0; transform: translateX(-50%) translateY(6px); }
                to   { opacity: 1; transform: translateX(-50%) translateY(0); }
            }
            #dt-in-lang:focus, #dt-out-lang:focus,
            #dt-ai-prov:focus, #dt-ai-model:focus, #dt-ai-key:focus {
                border-color: #5865f2 !important;
                box-shadow: 0 0 0 2px rgba(88,101,242,.25);
            }
            #discord-translator-panel [data-dt-tip] { cursor: default; }
            ::-webkit-scrollbar { width: 4px; }
            ::-webkit-scrollbar-track { background: transparent; }
            ::-webkit-scrollbar-thumb { background: #3a3c40; border-radius: 2px; }
        `;
        document.head.appendChild(style);
    }

    // =====================================================================
    // BOOTSTRAP
    // =====================================================================
    function boot() {
        injectStyles();
        const tryInit = () => {
            const root = document.getElementById('app-mount') || document.querySelector('[class*="app-"]');
            if (!root) { setTimeout(tryInit, 800); return; }
            buildPanel();
            setupTooltips();
            startObserver();
            if (S.incomingLang() !== 'en') translateUIStrings(S.incomingLang());
            showToast('🌐 Discord Translator active');
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', tryInit);
        } else {
            tryInit();
        }
    }

    boot();

})();
