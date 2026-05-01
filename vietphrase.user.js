// ==UserScript==
// @name         Vietphrase Realtime Translator Lite
// @namespace    https://github.com/duongden/script-vietphrase-translator
// @version      2.2.0
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
  const CHINESE_RE = /[㐀-䶿一-鿿豈-﫿〇]/;
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

  const settings = {
    ngoac: false,
    motnghia: true,
    daucach: '/',
    dichlieu: true,
    heightauto: true,
    scaleauto: true,
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

  function gmGet(key, def) {
    try {
      const v = GM_getValue(key);
      return v !== undefined && v !== null ? v : def;
    } catch (e) {
      return def;
    }
  }

  function gmSet(key, val) {
    try { GM_setValue(key, val); } catch (e) { /* silent */ }
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
        ontimeout: () => reject(new Error(`Timeout: ${url}`)),
        timeout: 30000,
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
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
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
    ['“', '\x02'], ['”', '\x03'],
    ['‘', '\x04'], ['’', '\x05'],
    ['【', '['], ['】', ']'],
    ['〔', '['], ['〕', ']'],
    ['〖', '['], ['〗', ']'],
    ['（', '('], ['）', ')'],
    ['｛', '{'], ['｝', '}'],
    ['。', '.'], ['！', '!'], ['？', '?'],
    ['；', ';'], ['：', ':'], ['，', ','], ['、', ','],
    ['……', '...'], ['…', '...'],
    ['——', '—'], ['—', '—'], ['－', '-'], ['～', '~'],
    ['•', '·'], ['　', ' '],
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
      .replace(/\x04/g, '‘')
      .replace(/\x05/g, '’');
  }

  function joinTranslatedTokens(tokens) {
    const VIET_RE = /[a-zA-ZÀ-ỹ]/;
    const CLOSE_RE = /^[\x03,.:;!?)»\]]/;
    const OPEN_RE = /[\x02([]\s*$/;
    let result = '';

    for (const tok of tokens) {
      if (!tok) continue;
      if (!result) { result = tok; continue; }

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
        if (seg.isName) { nextSegments.push(seg); continue; }
        const parts = seg.text.split(name);
        if (parts.length === 1) { nextSegments.push(seg); continue; }
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
      if (seg.isName) { tokens.push(seg.text); continue; }
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
        if (dichlieu && DICH_LIEU_SET.has(c)) { i++; continue; }
        tokens.push(dictPA[c] || c);
        i++;
      }
    }

    let result = postProcessTranslatedText(joinTranslatedTokens(tokens));
    result = autoCapitalize(result);
    return resolvePlaceholders(result);
  }

  const VP_EXCLUDE_IDS = new Set(['_vp_theme_style']);
  const CHUNK_SIZE = 80;
  const VIET_END_RE = /[a-zA-ZÀ-ỹ]$/;
  const VIET_START_RE = /^[a-zA-ZÀ-ỹ]/;

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
    if (_translateRunning && !rootNodes) return;
    if (!rootNodes) _translateRunning = true;
    const session = ++_translateSession;

    try {
      if (!isLoaded) await loadDicts();
    } catch (err) {
      console.warn('[VP Lite] loadDicts failed:', err);
      if (!rootNodes) _translateRunning = false;
      return;
    }

    const priorityBuckets = [[], [], [], []];
    function collectByPriority(node) {
      if (!node) return;
      const tag = node.nodeType === 1 ? node.tagName : '';
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
      if (VP_EXCLUDE_IDS.has(node.nodeType === 1 ? (node.id || '') : '')) return;

      if (node.nodeType === 3) {
        if (CHINESE_RE.test(node.textContent) && !node._vpTranslated) {
          const prio = getNodePriority(node.parentElement);
          priorityBuckets[prio].push({ arr: [node], texts: [node.textContent] });
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
      if (_translateSession === session && firstTrans) {
        firstTrans = false;
        startObserver();
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
        if (child._vpSpaceNode) { toRemove.push(child); continue; }
        if (child.nodeType === 3 && child._vpOrigin) {
          child.textContent = child._vpOrigin;
          child._vpOrigin = undefined;
          child._vpTranslated = false;
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
      for (const m of mutations) {
        if (m.type === 'childList') {
          for (const n of m.addedNodes) {
            if (n.nodeType === 3 || n.nodeType === 1) pendingNodes.add(n);
          }
        }
      }

      if (mutLock) { deferCheck = true; return; }
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
    if (!settings.heightauto && !settings.scaleauto) return;

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

  GM_registerMenuCommand('▶ Dịch trang', () => realtimeTranslate(true));
  GM_registerMenuCommand('🔄 Làm mới bản dịch', () => restoreAndRetranslate());

  (async function init() {
    const stored = gmGet('vp_lite_options', null);
    if (stored && typeof stored === 'object') {
      // Chỉ lấy settings không liên quan đến bật/tắt từ storage
      const safeKeys = ['ngoac', 'motnghia', 'daucach', 'dichlieu', 'heightauto', 'scaleauto', 'delayMutation', 'delayTrans'];
      for (const k of safeKeys) {
        if (stored[k] !== undefined) settings[k] = stored[k];
      }
    }
    deferDelay = settings.delayMutation;
    translateDelay = settings.delayTrans;

    try {
      await loadDicts();
    } catch (err) {
      console.warn('[VP Lite] loadDicts failed on init:', err);
    }

    const doTranslate = () => setTimeout(() => realtimeTranslate(true), translateDelay);
    if (document.body) doTranslate();
    else document.addEventListener('DOMContentLoaded', doTranslate);
  })();
})();
