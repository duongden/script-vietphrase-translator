// ==UserScript==
// @name         Vietphrase Realtime Translator Lite
// @namespace    https://github.com/duongden/script-vietphrase-translator
// @version      2.1.4
// @description  Dịch trực tiếp văn bản Hán ngữ sang tiếng Việt trên mọi trang web bằng từ điển Vietphrase tải từ link GitHub raw.
// @author       duongden
// @license      GPL-3.0
// @icon         https://raw.githubusercontent.com/duongden/script-vietphrase-translator/main/icon.png
// @homepageURL  https://github.com/duongden/script-vietphrase-translator
// @supportURL   https://github.com/duongden/script-vietphrase-translator/issues
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

/* jshint esversion:11 */
(function () {
  'use strict';

  const DB_NAME = 'VietphraseDBLite';
  const DB_VER = 1;
  const STORE = 'dicts';
  const CHINESE_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3007]/;
  const DICH_LIEU_SET = new Set(['的', '了', '着', '著']);
  const DEFAULT_DICT_URLS = {
    PA: 'https://raw.githubusercontent.com/duongden/script-vietphrase-translator/refs/heads/main/ChinesePhienAmWords.txt',
    VP: 'https://raw.githubusercontent.com/duongden/script-vietphrase-translator/refs/heads/main/Vietphrase.txt',
    Names: 'https://raw.githubusercontent.com/duongden/script-vietphrase-translator/refs/heads/main/Names.txt'
  };

  let _db = null;
  let dictPA = {};
  let dictVP = {};
  let dictNames = {};
  let dictVPKeys = [];
  let dictNamesKeys = [];
  let isLoaded = false;

  let settings = {
    enable: true,
    ngoac: false,
    motnghia: true,
    daucach: '/',
    dichlieu: true,
    showTransBtn: true,
    heightauto: true,
    widthauto: false,
    scaleauto: true,
    enableajax: false,
    enablescript: true,
    delayMutation: 200,
    delayTrans: 120,
  };

  let deferDelay = 200;
  let translateDelay = 120;
  let firstTrans = true;
  let mutLock = false;
  let deferCheck = false;
  let observer = null;
  let _translateRunning = false;
  let _translateSession = 0;
  let _floatPanel = null;
  let _ajaxAttached = false;
  let _tooltip = null;
  let _tipTimer = null;
  let _panelCollapsed = false;
  const _isTouchDevice = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;

  function gmGet(key, def) {
    try {
      const v = GM_getValue(key);
      return v !== undefined && v !== null ? v : def;
    } catch (e) {
      return def;
    }
  }

  function gmSet(key, val) {
    try {
      GM_setValue(key, val);
    } catch (e) { /* silent */ }
  }

  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: r => r.status >= 200 && r.status < 300
          ? resolve(r.responseText)
          : reject(new Error(`HTTP ${r.status}: ${url}`)),
        onerror: () => reject(new Error(`Network error: ${url}`)),
      });
    });
  }

  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'name' });
        }
      };
      req.onsuccess = e => {
        _db = e.target.result;
        resolve(_db);
      };
      req.onerror = e => reject(e.target.error);
    });
  }

  async function dbGet(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(key);
      req.onsuccess = e => resolve(e.target.result ? e.target.result.data : null);
      req.onerror = e => reject(e.target.error);
    });
  }

  async function dbSet(key, data) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put({ name: key, data });
      req.onsuccess = () => resolve();
      req.onerror = e => reject(e.target.error);
    });
  }

  async function dbGetAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).getAll();
      req.onsuccess = e => {
        const out = {};
        for (const item of e.target.result) out[item.name] = item.data;
        resolve(out);
      };
      req.onerror = e => reject(e.target.error);
    });
  }

  function parseDict(text, mode = '') {
    const out = {};
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('//') || line.startsWith('#') || line.startsWith('=')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (!k || !v) continue;
      if (mode === 'PA') {
        const chars = [...k];
        if (!chars.every(ch => CHINESE_RE.test(ch)) || chars.length !== 1) continue;
      }
      out[k] = v;
    }
    return out;
  }

  function sortByLenDesc(obj) {
    return Object.keys(obj).sort((a, b) => b.length - a.length || a.localeCompare(b));
  }

  async function fetchDefaultDict(dictKey) {
    const text = await gmFetch(DEFAULT_DICT_URLS[dictKey]);
    return parseDict(text, dictKey === 'PA' ? 'PA' : '');
  }

  async function ensureBaseDicts(all) {
    const merged = Object.assign({}, (all || {}));
    const missing = ['PA', 'VP', 'Names'].filter(k => !merged[k] || !Object.keys(merged[k]).length);
    if (!missing.length) return merged;

    const fetched = await Promise.all(missing.map(async key => {
      const parsed = await fetchDefaultDict(key);
      await dbSet(key, parsed);
      return [key, parsed];
    }));

    for (const [key, parsed] of fetched) merged[key] = parsed;
    return merged;
  }

  async function loadDicts() {
    let all = await dbGetAll();
    all = await ensureBaseDicts(all);
    dictPA = all.PA || {};
    dictVP = all.VP || {};
    dictNames = all.Names || {};
    dictVPKeys = sortByLenDesc(dictVP);
    dictNamesKeys = sortByLenDesc(dictNames);
    isLoaded = true;
    console.log(`[VP Lite] PA=${Object.keys(dictPA).length} VP=${dictVPKeys.length} Names=${dictNamesKeys.length}`);
  }


  function hasHanChar(text) {
    return CHINESE_RE.test(String(text || ''));
  }

  function isHanChar(ch) {
    return CHINESE_RE.test(ch);
  }

  function takeNonHanRun(text, start) {
    let end = start;
    while (end < text.length && !isHanChar(text[end])) end++;
    return text.slice(start, end);
  }

  const PUNCT_MAP = [
    ['。》', '.\x03'], ['。』', '.\x03'], ['。」', '.\x03'],
    ['？》', '?\x03'], ['！》', '!\x03'],
    ['《', '\x02'], ['》', '\x03'],
    ['〈', '\x02'], ['〉', '\x03'],
    ['「', '\x02'], ['」', '\x03'],
    ['『', '\x02'], ['』', '\x03'],
    ['\u201c', '\x02'], ['\u201d', '\x03'],
    ['\u2018', '\x04'], ['\u2019', '\x05'],
    ['【', '['], ['】', ']'],
    ['〔', '['], ['〕', ']'],
    ['〖', '['], ['〗', ']'],
    ['（', '('], ['）', ')'],
    ['｛', '{'], ['｝', '}'],
    ['。', '.'], ['！', '!'], ['？', '?'],
    ['；', ';'], ['：', ':'], ['，', ','], ['、', ','],
    ['……', '...'], ['…', '...'],
    ['——', '—'], ['—', '—'], ['－', '-'], ['～', '~'],
    ['•', '·'], ['\u3000', ' '],
    ['／', '/'], ['＼', '\\'],
    ['！', '!'], ['＂', '"'], ['＃', '#'], ['＄', '$'], ['％', '%'],
    ['＆', '&'], ['＇', "'"], ['＊', '*'], ['＋', '+'], ['＜', '<'],
    ['＝', '='], ['＞', '>'], ['＠', '@'], ['［', '['], ['］', ']'],
    ['＾', '^'], ['＿', '_'], ['｀', '`'], ['｜', '|'],
  ];

  function normalizePunct(s) {
    for (const [from, to] of PUNCT_MAP) {
      if (s.includes(from)) s = s.split(from).join(to);
    }
    return s;
  }

  function resolvePlaceholders(s) {
    return s
      .replace(/\x02/g, '"')
      .replace(/\x03/g, '"')
      .replace(/\x04/g, '\u2018')
      .replace(/\x05/g, '\u2019');
  }

  function joinTranslatedTokens(tokens) {
    const VIET_RE = /[a-zA-ZÀ-ỹ]/;
    const CLOSE_RE = /^[\x03,.:;!?)»\]]/;
    const OPEN_RE = /[\x02([]\s*$/;
    let result = '';

    for (const tok of tokens) {
      if (!tok) continue;
      if (!result) {
        result = tok;
        continue;
      }

      const last = result[result.length - 1];
      const first = tok[0];

      if (CLOSE_RE.test(first)) result += tok;
      else if (OPEN_RE.test(last)) result += tok;
      else if (last === ' ') result += tok;
      else if (VIET_RE.test(last) || VIET_RE.test(first)) result += ' ' + tok;
      else if (last === '\x03' || last === '\x05') result += ' ' + tok;
      else result += tok;
    }

    return result;
  }

  function postProcessTranslatedText(text) {
    return text
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([\x03,.:;!?)»\]])/g, '$1')
      .replace(/([\x02([])\s+/g, '$1')
      .replace(/(\x03)([a-zA-ZÀ-ỹ\x02([])/g, '$1 $2')
      .replace(/([a-zA-ZÀ-ỹ\x03\])])(\x02)/g, '$1 $2')
      .replace(/([:;!?,])([a-zA-ZÀ-ỹ\x02])/g, '$1 $2')
      .replace(/([a-zA-ZÀ-ỹ])([([])/g, '$1 $2')
      .trim();
  }

  function autoCapitalize(s) {
    if (!s || !s.trim()) return s;
    const trimmed = s.trimStart();
    if (trimmed) s = trimmed[0].toUpperCase() + trimmed.slice(1);
    // Viết hoa sau dấu kết câu: ". ", "! ", "? " (hỗ trợ cả khi thiếu space)
    s = s.replace(/([.!?])(\s*)([a-zàáâãèéêìíòóôõùúýăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỷỹ])/g,
      (_, p, sp, c) => p + sp + c.toUpperCase());
    s = s.replace(/(:\s+\x02)([a-zàáâãèéêìíòóôõùúýăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỷỹ])/g,
      (_, pre, c) => pre + c.toUpperCase());
    s = s.replace(/((?:^|\s)\x02)([a-zàáâãèéêìíòóôõùúýăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỷỹ])/g,
      (_, pre, c) => pre + c.toUpperCase());
    return s;
  }

  function translateText(text) {
    if (!text || !text.trim() || !hasHanChar(text)) return text;
    const { ngoac, motnghia, daucach, dichlieu } = settings;
    text = normalizePunct(text);

    let segments = [{ text, isName: false }];
    for (const name of dictNamesKeys) {
      if (!name) continue;
      const nextSegments = [];
      for (const seg of segments) {
        if (seg.isName) {
          nextSegments.push(seg);
          continue;
        }
        const parts = seg.text.split(name);
        if (parts.length === 1) {
          nextSegments.push(seg);
          continue;
        }
        let nameVal = dictNames[name];
        nameVal = motnghia ? nameVal.split(daucach)[0].trim() : nameVal.trim();
        if (ngoac) nameVal = '[' + nameVal + ']';
        for (let pi = 0; pi < parts.length; pi++) {
          if (parts[pi].length) nextSegments.push({ text: parts[pi], isName: false });
          if (pi < parts.length - 1) nextSegments.push({ text: nameVal, isName: true });
        }
      }
      segments = nextSegments;
    }

    const tokens = [];
    const maxLen = dictVPKeys.length ? dictVPKeys[0].length : 1;

    for (const seg of segments) {
      if (seg.isName) {
        tokens.push(seg.text);
        continue;
      }
      const s = seg.text;
      let i = 0;
      while (i < s.length) {
        let matched = false;
        const remaining = s.length - i;
        for (let j = Math.min(maxLen, remaining); j > 0; j--) {
          const sub = s.slice(i, i + j);
          const vp = dictVP[sub];
          if (vp !== undefined) {
            let t = motnghia ? vp.split(daucach)[0].trim() : vp.trim();
            if (ngoac) t = '[' + t + ']';
            tokens.push(t);
            i += j;
            matched = true;
            break;
          }
        }
        if (matched) continue;

        const c = s[i];
        if (!isHanChar(c)) {
          const raw = takeNonHanRun(s, i);
          if (raw) tokens.push(raw);
          i += raw.length || 1;
          continue;
        }
        if (dichlieu && DICH_LIEU_SET.has(c)) {
          i++;
          continue;
        }
        tokens.push(dictPA[c] || c);
        i++;
      }
    }

    let result = postProcessTranslatedText(joinTranslatedTokens(tokens));
    result = autoCapitalize(result);
    return resolvePlaceholders(result);
  }

  function injectThemeStyle() {
    if (document.getElementById('_vp_theme_style')) return;
    const style = document.createElement('style');
    style.id = '_vp_theme_style';
    style.textContent = `
      ._vp_ui {
        color-scheme: light dark;
        --vp-bg: rgba(255, 255, 255, 0.85);
        --vp-text: #1e293b;
        --vp-primary: #6366f1;
        --vp-primary-bg: #e0e7ff;
        --vp-border: rgba(0, 0, 0, 0.08);
        --vp-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
        --vp-glass: blur(16px) saturate(180%);
      }
      @media (prefers-color-scheme: dark) {
        ._vp_ui {
          --vp-bg: rgba(30, 41, 59, 0.82);
          --vp-text: #f1f5f9;
          --vp-primary: #818cf8;
          --vp-primary-bg: #1e1b4b;
          --vp-border: rgba(255, 255, 255, 0.1);
          --vp-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        }
      }
      ._vp_ui, ._vp_ui * { box-sizing: border-box; font-family: Inter, system-ui, -apple-system, sans-serif; }
      #_vp_float_panel {
        position: fixed; right: 16px; bottom: calc(16px + env(safe-area-inset-bottom, 0px));
        z-index: 2147483646;
        display: flex; flex-direction: column; align-items: flex-end; gap: 8px; pointer-events: none;
      }
      #_vp_float_panel > * { pointer-events: auto; }
      .vp-fpanel-btn {
        display: flex; align-items: center; justify-content: center; gap: 0;
        width: 44px; height: 44px; padding: 0;
        background: var(--vp-bg); color: var(--vp-text);
        border: 1px solid var(--vp-border); border-radius: 12px;
        box-shadow: var(--vp-shadow); backdrop-filter: var(--vp-glass);
        cursor: pointer; font-size: 12px; font-weight: 700;
        overflow: hidden; white-space: nowrap;
        transition: all 0.3s ease;
      }
      .vp-fpanel-btn .fp-label { display: none; }
      #_vp_float_panel.vp-expanded .vp-fpanel-btn:not(.vp-panel-toggle) {
        width: auto; padding: 10px 14px; gap: 8px; justify-content: flex-start;
      }
      #_vp_float_panel.vp-expanded .vp-fpanel-btn:not(.vp-panel-toggle) .fp-label { display: inline; }
      .vp-fpanel-btn .fp-icon { width: 20px; height: 20px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
      .vp-fpanel-btn .fp-icon svg { width: 100%; height: 100%; fill: currentColor; }
      .vp-fpanel-btn.green { color: #10b981; }
      .vp-fpanel-btn.off { opacity: 0.6; }
      .vp-panel-toggle { border-style: dashed; }
      @media (hover: hover) {
        .vp-fpanel-btn:not(.vp-panel-toggle):hover {
          width: auto; padding: 10px 14px; gap: 8px; justify-content: flex-start;
          transform: translateY(-2px); border-color: var(--vp-primary);
        }
        .vp-fpanel-btn:not(.vp-panel-toggle):hover .fp-label { display: inline; }
      }

      #_vp_tooltip {
        position: fixed; z-index: 2147483647; pointer-events: none;
        background: var(--vp-bg); color: var(--vp-text);
        padding: 12px 18px; border-radius: 16px; border: 1px solid var(--vp-border);
        box-shadow: var(--vp-shadow); backdrop-filter: var(--vp-glass);
        font-size: 15px; line-height: 1.6; max-width: 400px; word-break: break-word;
        font-family: inherit;
      }

      @media (max-width: 768px) {
        #_vp_float_panel { right: 12px; bottom: calc(52px + env(safe-area-inset-bottom, 0px)); }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  const VP_EXCLUDE_IDS = new Set(['_vp_tooltip', '_vp_float_panel', '_vp_theme_style']);
  const CHUNK_SIZE = 80;
  const VIET_END_RE = /[a-zA-Z\u00C0-\u1EF9]$/;
  const VIET_START_RE = /^[a-zA-Z\u00C0-\u1EF9]/;

  function getNodePriority(el) {
    if (!el) return 3;
    const tag = el.tagName;
    if (!tag) return 3;
    if (tag === 'ARTICLE' || tag === 'MAIN' || tag === 'SECTION') return 1;
    if (tag === 'ASIDE' || tag === 'NAV' || tag === 'HEADER') return 2;
    if (tag === 'FOOTER') return 3;
    return 0;
  }

  function recurTraver(node, arr, texts) {
    if (!node) return;
    const tag = node.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
    if (VP_EXCLUDE_IDS.has(node.id || '')) return;

    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        if (child._vpSpaceNode) continue;
        if (CHINESE_RE.test(child.textContent) && !child._vpTranslated) {
          arr.push(child);
          texts.push(child.textContent);
        }
      } else if (child.nodeType === 1) {
        recurTraver(child, arr, texts);
      }
    }

    if (node.shadowRoot) recurTraver(node.shadowRoot, arr, texts);
  }

  function getTrailingChar(node) {
    if (!node) return '';
    if (node._vpSpaceNode) return ' ';
    if (node.nodeType === 3) {
      const t = node.textContent;
      return t ? t[t.length - 1] : '';
    }
    if (node.nodeType === 1) {
      if (VP_EXCLUDE_IDS.has(node.id || '')) return '';
      for (let c = node.lastChild; c; c = c.previousSibling) {
        const ch = getTrailingChar(c);
        if (ch) return ch;
      }
    }
    return '';
  }

  function getLeadingChar(node) {
    if (!node) return '';
    if (node._vpSpaceNode) return ' ';
    if (node.nodeType === 3) {
      const t = node.textContent;
      return t ? t[0] : '';
    }
    if (node.nodeType === 1) {
      if (VP_EXCLUDE_IDS.has(node.id || '')) return '';
      for (let c = node.firstChild; c; c = c.nextSibling) {
        const ch = getLeadingChar(c);
        if (ch) return ch;
      }
    }
    return '';
  }

  function hasBoundaryChar(node) {
    return !!(getLeadingChar(node) || getTrailingChar(node));
  }

  function getPrevMeaningfulSibling(node) {
    let cur = node ? node.previousSibling : null;
    while (cur) {
      if (hasBoundaryChar(cur)) return cur;
      cur = cur.previousSibling;
    }
    return null;
  }

  function getNextMeaningfulSibling(node) {
    let cur = node ? node.nextSibling : null;
    while (cur) {
      if (hasBoundaryChar(cur)) return cur;
      cur = cur.nextSibling;
    }
    return null;
  }

  function injectSpaceBetween(parent, before, after) {
    if (!parent || !before || !after) return;
    let cur = before.nextSibling;
    while (cur && cur !== after) {
      if (cur._vpSpaceNode) return;
      if (cur.nodeType === 3 && /\s/.test(cur.textContent || '')) return;
      if (hasBoundaryChar(cur)) return;
      cur = cur.nextSibling;
    }
    if (cur !== after) return;
    const sp = document.createTextNode(' ');
    sp._vpSpaceNode = true;
    parent.insertBefore(sp, after);
  }

  function fixSpacingForNode(textNode) {
    if (textNode._vpSpaceNode) return;
    const parent = textNode.parentElement;
    if (!parent) return;

    const checkAndFix = (nodeA, nodeB) => {
      if (!nodeA || !nodeB) return;
      const trailing = getTrailingChar(nodeA);
      const leading = getLeadingChar(nodeB);
      if (!trailing || !leading) return;
      if (trailing === ' ' || leading === ' ') return;
      if (VIET_END_RE.test(trailing) && VIET_START_RE.test(leading)) {
        injectSpaceBetween(nodeA.parentNode, nodeA, nodeB);
      }
    };

    checkAndFix(getPrevMeaningfulSibling(textNode), textNode);
    checkAndFix(textNode, getNextMeaningfulSibling(textNode));
  }

  function getTooltip() {
    if (_tooltip) return _tooltip;
    injectThemeStyle();
    _tooltip = document.createElement('div');
    _tooltip.id = '_vp_tooltip';
    _tooltip.className = '_vp_ui';
    _tooltip.style.display = 'none';
    document.body.appendChild(_tooltip);
    return _tooltip;
  }

  function positionTip(e) {
    if (!_tooltip) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = e.clientX + 14;
    let y = e.clientY + 16;
    const tw = Math.min(360, vw * 0.45);
    if (x + tw > vw - 12) x = e.clientX - tw - 12;
    if (y + 80 > vh) y = e.clientY - 70;
    _tooltip.style.left = x + 'px';
    _tooltip.style.top = y + 'px';
  }

  function onNodeMouseEnter(e) {
    let original = '';
    for (const child of e.currentTarget.childNodes) {
      if (child.nodeType === 3 && child._vpOrigin) original += child._vpOrigin;
    }
    if (!original) return;
    clearTimeout(_tipTimer);
    const tip = getTooltip();
    tip.textContent = original;
    tip.style.display = 'block';
    positionTip(e);
  }

  function onNodeMouseMove(e) {
    if (_tooltip && _tooltip.style.display !== 'none') positionTip(e);
  }

  function initGlobalEvents() {
    if (_isTouchDevice) return;
    document.body.addEventListener('mouseover', e => {
      const p = e.target.closest('._vp_translated_parent');
      if (p) onNodeMouseEnter({ currentTarget: p, clientX: e.clientX, clientY: e.clientY });
    });
    document.body.addEventListener('mouseout', e => {
      const p = e.target.closest('._vp_translated_parent');
      if (p) onNodeMouseLeave();
    });
    document.body.addEventListener('mousemove', e => {
      const p = e.target.closest('._vp_translated_parent');
      if (p) onNodeMouseMove(e);
    });
  }

  function onNodeMouseLeave() {
    clearTimeout(_tipTimer);
    _tipTimer = setTimeout(() => {
      if (_tooltip) _tooltip.style.display = 'none';
    }, 120);
  }

  async function translateChunked(arr, texts, session) {
    for (let start = 0; start < arr.length; start += CHUNK_SIZE) {
      if (_translateSession !== session) return;
      const chunkArr = arr.slice(start, start + CHUNK_SIZE);
      const chunkTexts = texts.slice(start, start + CHUNK_SIZE);
      const translated = chunkTexts.map(text => translateText(text));

      if (_translateSession !== session) return;
      chunkArr.forEach((node, i) => {
        node._vpOrigin = node.textContent;
        node.textContent = translated[i];
        node._vpTranslated = true;
        const parent = node.parentElement;
        if (parent) {
          parent.classList.add('_vp_translated_parent');
        }
      });

      if (start + CHUNK_SIZE < arr.length) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    if (_translateSession !== session) return;
    for (const node of arr) {
      if (node._vpTranslated) fixSpacingForNode(node);
    }
  }

  async function realtimeTranslate(force = false, rootNodes = null) {
    if (!settings.enable && !force) return;
    if (!isLoaded) await loadDicts();
    if (_translateRunning && !rootNodes) return;

    if (!rootNodes) _translateRunning = true;
    const session = ++_translateSession;

    const priorityBuckets = [[], [], [], []];
    function collectByPriority(node) {
      if (!node) return;
      const tag = node.nodeType === 1 ? node.tagName : '';
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
      if (VP_EXCLUDE_IDS.has(node.nodeType === 1 ? (node.id || '') : '')) return;

      if (node.nodeType === 3) {
        if (CHINESE_RE.test(node.textContent) && !node._vpTranslated) {
          const prio = getNodePriority(node.parentElement);
          const arr = [node], texts = [node.textContent];
          priorityBuckets[prio].push({ arr, texts });
        }
      } else if (node.nodeType === 1 || node.nodeType === 11) {
        const prio = getNodePriority(node);
        const arr = []; const texts = [];
        recurTraver(node, arr, texts);
        if (arr.length) priorityBuckets[prio].push({ arr, texts });
      }
    }

    if (rootNodes) {
      rootNodes.forEach(n => collectByPriority(n));
    } else if (document.body) {
      for (const child of document.body.children) collectByPriority(child);
      const titleEl = document.querySelector('title');
      if (titleEl) {
        const arr = []; const texts = [];
        recurTraver(titleEl, arr, texts);
        if (arr.length) priorityBuckets[0].unshift({ arr, texts });
      }
    }

    const allArr = [];
    const allTexts = [];
    for (const bucket of priorityBuckets) {
      for (const { arr, texts } of bucket) {
        allArr.push(...arr);
        allTexts.push(...texts);
      }
    }

    if (!allArr.length) {
      if (!rootNodes) _translateRunning = false;
      return;
    }

    try {
      await translateChunked(allArr, allTexts, session);
      if (_translateSession === session) {
        if (firstTrans) {
          firstTrans = false;
          if (settings.enablescript) startObserver();
          if (settings.enableajax) attachAjaxInterceptor();
          initGlobalEvents(); // Thêm event delegation
        }
        setTimeout(() => removeOverflow(allArr), 80);
      }
    } finally {
      if (!rootNodes) _translateRunning = false;
    }
  }

  function restoreAndRetranslate() {
    _translateSession++;
    _translateRunning = false;
    if (observer) observer.disconnect();

    function restore(node) {
      if (!node) return;
      if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;
      const toRemove = [];
      for (const child of node.childNodes) {
        if (child._vpSpaceNode) {
          toRemove.push(child);
          continue;
        }
        if (child.nodeType === 3 && child._vpOrigin) {
          child.textContent = child._vpOrigin;
          child._vpOrigin = undefined;
          child._vpTranslated = false;
          if (child.parentElement) child.parentElement.classList.remove('_vp_translated_parent');
        } else if (child.nodeType === 1) {
          restore(child);
        }
      }
      for (const n of toRemove) n.remove();
      if (node.shadowRoot) restore(node.shadowRoot);
    }

    restore(document.body);
    firstTrans = true;
    setTimeout(() => realtimeTranslate(true), 100);
  }

  function startObserver() {
    if (observer) observer.disconnect();
    const pendingNodes = new Set();
    observer = new MutationObserver((mutations) => {
      if (settings.enable === false) return;
      for (const m of mutations) {
        if (m.type === 'childList') {
          for (const n of m.addedNodes) {
            if (n.nodeType === 3 || n.nodeType === 1) pendingNodes.add(n);
          }
        }
      }

      if (mutLock) {
        deferCheck = true;
        return;
      }
      mutLock = true;
      setTimeout(() => {
        mutLock = false;
        if (deferCheck || pendingNodes.size > 0) {
          deferCheck = false;
          const nodes = [...pendingNodes];
          pendingNodes.clear();
          realtimeTranslate(false, nodes);
        }
      }, deferDelay);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function checkOverflow(el, stl) {
    stl = stl || getComputedStyle(el);
    const ov = stl.overflow;
    if (ov === 'auto' || ov === 'hidden') return false;
    return el.clientWidth < el.scrollWidth || el.clientHeight < el.scrollHeight;
  }

  function removeOverflow(nodes = null) {
    if (!settings.heightauto && !settings.widthauto && !settings.scaleauto) return;

    const targets = new Set();
    if (nodes) {
      for (const n of nodes) {
        let cur = n.parentElement;
        while (cur && cur !== document.body && !cur.hasAttribute('_vp_calc')) {
          const tag = cur.tagName;
          if (tag === 'DIV' || tag === 'NAV' || tag === 'MAIN' || tag === 'SECTION' || tag === 'ARTICLE') {
            targets.add(cur);
          }
          cur = cur.parentElement;
        }
      }
    } else {
      document.querySelectorAll('div:not([_vp_calc]),nav,main,section,article').forEach(e => targets.add(e));
    }

    targets.forEach(e => {
      e.setAttribute('_vp_calc', '1');
      const stl = getComputedStyle(e);
      if (!checkOverflow(e, stl)) return;

      if (settings.heightauto) {
        if (stl.maxHeight === 'none')
          e.style.maxHeight = (parseInt(stl.height, 10) * 2) + 'px';
        if (parseInt(stl.height, 10) + 'px' === stl.height)
          e.style.minHeight = stl.height;
        if (stl.overflowY !== 'auto' && stl.overflowY !== 'scroll')
          e.style.height = 'auto';
      }
      if (settings.widthauto) {
        if (parseInt(stl.width, 10) + 'px' === stl.width)
          e.style.minWidth = stl.width;
        e.style.width = 'auto';
      }
    });

    if (settings.scaleauto) {
      const sel = 'a:not([_vp_calc]),button:not([_vp_calc]),span:not([_vp_calc]),li:not([_vp_calc]),h1:not([_vp_calc]),h2:not([_vp_calc]),h3:not([_vp_calc]),h4:not([_vp_calc]),label:not([_vp_calc])';
      document.querySelectorAll(sel).forEach(e => {
        e.setAttribute('_vp_calc', '1');
        if (!checkOverflow(e)) return;
        const stl = getComputedStyle(e);
        let fontSize = parseInt(stl.fontSize, 10);
        if (!fontSize || fontSize <= 10) return;
        let multiply = 1;
        if (fontSize > 26) multiply = 4;
        else if (fontSize > 22) multiply = 3;
        else if (fontSize >= 16) multiply = 2;
        e.style.fontSize = Math.max(10, fontSize - multiply) + 'px';
      });
    }
  }

  // Monkey-patch XMLHttpRequest.send and window.fetch to trigger
  // re-translation after any AJAX response. This is intentional:
  // many novel/reading sites load chapter content dynamically via
  // XHR or fetch, so we need to detect and translate new Chinese
  // text that appears after these requests complete.
  function attachAjaxInterceptor() {
    if (_ajaxAttached || !settings.enableajax) return;
    _ajaxAttached = true;

    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('load', () => {
        if (settings.enable) setTimeout(() => realtimeTranslate(), translateDelay);
      });
      return origSend.apply(this, args);
    };

    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);
      if (settings.enable) setTimeout(() => realtimeTranslate(), translateDelay);
      return res;
    };
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICON_PATHS = {
    play: 'M8 5v14l11-7z',
    refresh: 'M17.65 6.35A7.95 7.95 0 0 0 12 4V1L7 6l5 5V7a5 5 0 1 1-5 5H5a7 7 0 1 0 12.65-5.65',
    progress: 'M12 2a10 10 0 1 0 10 10h-2a8 8 0 1 1-8-8z',
    done: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    toggleOn: 'M7 7h10a5 5 0 0 1 0 10H7A5 5 0 0 1 7 7m10 8a3 3 0 0 0 0-6H7a3 3 0 0 0 0 6zm0-1.5A2.5 2.5 0 1 0 17 8.5a2.5 2.5 0 0 0 0 5',
    toggleOff: 'M7 7h10a5 5 0 0 1 0 10H7A5 5 0 0 1 7 7m0 2a3 3 0 0 0 0 6h10a3 3 0 0 0 0-6zm0 4.5A2.5 2.5 0 1 1 7 8.5a2.5 2.5 0 0 1 0 5',
    hide: 'M19 13H5v-2h14z',
    show: 'M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z',
  };

  function createSvgIcon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'mi');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const pathData = ICON_PATHS[name] || '';
    if (pathData) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', pathData);
      svg.appendChild(path);
    }
    return svg;
  }

  function setIconContent(container, iconName) {
    while (container.firstChild) container.removeChild(container.firstChild);
    container.appendChild(createSvgIcon(iconName));
  }

  function mkBtn(iconName, label, cls, title) {
    const btn = document.createElement('button');
    btn.className = 'vp-fpanel-btn' + (cls ? ' ' + cls : '');
    btn.title = title || label;
    const iconSpan = document.createElement('span');
    iconSpan.className = 'fp-icon';
    iconSpan.appendChild(createSvgIcon(iconName));
    const labelSpan = document.createElement('span');
    labelSpan.className = 'fp-label';
    labelSpan.textContent = label;
    btn.appendChild(iconSpan);
    btn.appendChild(labelSpan);
    return btn;
  }

  function buildFloatPanel() {
    if (!settings.showTransBtn) {
      const existingPanel = document.getElementById('_vp_float_panel');
      if (existingPanel) existingPanel.remove();
      _floatPanel = null;
      return;
    }

    if (!_floatPanel || !document.getElementById('_vp_float_panel')) {
      injectThemeStyle();
      _floatPanel = document.createElement('div');
      _floatPanel.id = '_vp_float_panel';
      _floatPanel.className = '_vp_ui';
      document.body.appendChild(_floatPanel);
    }

    while (_floatPanel.firstChild) _floatPanel.removeChild(_floatPanel.firstChild);

    const btnTrans = mkBtn('play', 'Dịch VP', '', 'Dịch trang ngay');
    let transBusy = false;
    btnTrans.onclick = async () => {
      if (transBusy) return;
      transBusy = true;
      setIconContent(btnTrans.querySelector('.fp-icon'), 'progress');
      await realtimeTranslate(true);
      setIconContent(btnTrans.querySelector('.fp-icon'), 'done');
      setTimeout(() => {
        transBusy = false;
        setIconContent(btnTrans.querySelector('.fp-icon'), 'play');
      }, 1500);
    };
    _floatPanel.appendChild(btnTrans);

    const btnReload = mkBtn('refresh', 'Làm mới', 'green', 'Làm mới bản dịch');
    btnReload.onclick = () => {
      setIconContent(btnReload.querySelector('.fp-icon'), 'progress');
      restoreAndRetranslate();
      setTimeout(() => {
        setIconContent(btnReload.querySelector('.fp-icon'), 'refresh');
      }, 1200);
    };
    _floatPanel.appendChild(btnReload);

    if (_isTouchDevice) {
      const btnCollapse = document.createElement('button');
      btnCollapse.className = 'vp-fpanel-btn vp-panel-toggle';
      btnCollapse.title = _panelCollapsed ? 'Hiện menu' : 'Ẩn menu';
      const collapseIconSpan = document.createElement('span');
      collapseIconSpan.className = 'fp-icon';
      collapseIconSpan.appendChild(createSvgIcon(_panelCollapsed ? 'show' : 'hide'));
      btnCollapse.appendChild(collapseIconSpan);
      btnCollapse.onclick = () => {
        _panelCollapsed = !_panelCollapsed;
        gmSet('vp_lite_panel_collapsed', _panelCollapsed);
        if (_panelCollapsed) {
          _floatPanel.classList.remove('vp-expanded');
          btnCollapse.title = 'Hiện menu';
          setIconContent(collapseIconSpan, 'show');
        } else {
          _floatPanel.classList.add('vp-expanded');
          btnCollapse.title = 'Ẩn menu';
          setIconContent(collapseIconSpan, 'hide');
        }
      };
      _floatPanel.appendChild(btnCollapse);
      _floatPanel.classList.toggle('vp-expanded', !_panelCollapsed);
    }

    const isOn = settings.enable;
    const btnToggle = mkBtn(
      isOn ? 'toggleOn' : 'toggleOff',
      isOn ? 'Auto ON' : 'Auto OFF',
      isOn ? 'green' : 'off',
      isOn ? 'Tắt dịch tự động' : 'Bật dịch tự động'
    );
    btnToggle.onclick = () => {
      settings.enable = !settings.enable;
      gmSet('vp_lite_options', Object.assign({}, settings));
      buildFloatPanel();
      if (settings.enable) realtimeTranslate(true);
    };
    _floatPanel.appendChild(btnToggle);
  }

  GM_registerMenuCommand('▶ Dịch trang', () => realtimeTranslate(true));
  GM_registerMenuCommand('🔄 Làm mới bản dịch', () => restoreAndRetranslate());
  GM_registerMenuCommand('⏯ Bật/Tắt auto translate', () => {
    settings.enable = !settings.enable;
    gmSet('vp_lite_options', Object.assign({}, settings));
    buildFloatPanel();
    if (settings.enable) realtimeTranslate(true);
  });

  (async function init() {
    const stored = gmGet('vp_lite_options', null);
    if (stored && typeof stored === 'object') Object.assign(settings, stored);
    if (_isTouchDevice) _panelCollapsed = !!gmGet('vp_lite_panel_collapsed', false);
    deferDelay = settings.delayMutation !== undefined && settings.delayMutation !== null ? settings.delayMutation : 200;
    translateDelay = settings.delayTrans !== undefined && settings.delayTrans !== null ? settings.delayTrans : 120;

    try {
      await loadDicts();
    } catch (err) {
      console.warn('[VP Lite] loadDicts failed:', err);
    }

    if (document.body) buildFloatPanel();
    else document.addEventListener('DOMContentLoaded', buildFloatPanel);

    if (settings.enable) {
      setTimeout(() => realtimeTranslate(), translateDelay);
    }

    if (settings.enableajax) attachAjaxInterceptor();
  })();
})();
