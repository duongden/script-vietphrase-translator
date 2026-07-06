// ==UserScript==
// @name         Vietphrase Realtime Translator Lite
// @namespace    https://github.com/duongden/script-vietphrase-translator
// @version      2.2.7
// @description  Dịch trực tiếp văn bản Hán ngữ sang tiếng Việt bằng từ điển mặc định hoặc từ điển cá nhân.
// @author       duongden
// @license      GPL-3.0
// @icon         https://raw.githubusercontent.com/duongden/script-vietphrase-translator/main/icon.png
// @homepageURL  https://github.com/duongden/script-vietphrase-translator
// @supportURL   https://github.com/duongden/script-vietphrase-translator/issues
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

/* jshint esversion:11 */
(function () {
  'use strict';

  const CHINESE_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3007]/;
  const DICH_LIEU_SET = new Set(['的', '了', '着', '著']);
  const DICT_TYPES = ['PA', 'VP', 'Names'];
  const DICT_STORAGE_PREFIX = 'vp_lite_dict_';
  const DICT_META_KEY = 'vp_lite_dict_meta';
  const DEFAULT_DICT_URLS = {
    PA: 'https://raw.githubusercontent.com/duongden/script-vietphrase-translator/refs/heads/main/ChinesePhienAmWords.txt',
    VP: 'https://raw.githubusercontent.com/duongden/script-vietphrase-translator/refs/heads/main/Vietphrase.txt',
    Names: 'https://raw.githubusercontent.com/duongden/script-vietphrase-translator/refs/heads/main/Names.txt'
  };

  function fixVietnamese(text) {
    return (text ?? '').toString().normalize('NFC');
  }

  function normalizeDictObject(data) {
    const normalized = {};
    for (const [key, value] of Object.entries(data || {})) {
      normalized[fixVietnamese(key)] = fixVietnamese(value);
    }
    return normalized;
  }

  function injectVietnameseStyle() {
    if (document.getElementById('_vp_lite_vietnamese_style')) return;
    const style = document.createElement('style');
    style.id = '_vp_lite_vietnamese_style';
    style.textContent = `
      ._vp_translated_parent {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", Arial, sans-serif !important;
        text-rendering: optimizeLegibility;
        -webkit-font-smoothing: antialiased;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

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
    try {
      GM_setValue(key, val);
      return true;
    } catch (e) {
      console.warn(`[VP Lite] Không thể lưu ${key}:`, e);
      return false;
    }
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

  function isValidDict(data) {
    return data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length > 0;
  }

  function getStoredDict(dictKey) {
    const data = gmGet(DICT_STORAGE_PREFIX + dictKey, null);
    return isValidDict(data) ? data : null;
  }

  function saveStoredDict(dictKey, data, source) {
    if (!isValidDict(data)) throw new Error(`Từ điển ${dictKey} không có mục từ hợp lệ`);
    if (!gmSet(DICT_STORAGE_PREFIX + dictKey, data)) {
      throw new Error(`Tampermonkey không thể lưu từ điển ${dictKey}`);
    }
    const storedMeta = gmGet(DICT_META_KEY, {});
    const meta = storedMeta && typeof storedMeta === 'object' ? storedMeta : {};
    meta[dictKey] = {
      source,
      count: Object.keys(data).length,
      updatedAt: new Date().toISOString(),
    };
    gmSet(DICT_META_KEY, meta);
  }

  function parseDict(text, mode = '') {
    const out = {};
    for (const raw of fixVietnamese(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('//') || line.startsWith('#') || line.startsWith('=')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const k = fixVietnamese(line.slice(0, eq)).trim();
      const v = fixVietnamese(line.slice(eq + 1)).trim();
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

  async function ensureBaseDicts() {
    const merged = {};
    for (const key of DICT_TYPES) merged[key] = getStoredDict(key);
    const missing = DICT_TYPES.filter(key => !merged[key]);
    if (!missing.length) return merged;

    const fetched = await Promise.all(missing.map(async key => {
      const parsed = await fetchDefaultDict(key);
      // Người dùng có thể upload trong lúc request mặc định đang chạy.
      const current = getStoredDict(key);
      if (current) return [key, current];
      saveStoredDict(key, parsed, 'default');
      return [key, parsed];
    }));

    for (const [key, parsed] of fetched) merged[key] = parsed;
    return merged;
  }

  async function loadDicts() {
    const all = await ensureBaseDicts();
    dictPA = normalizeDictObject(all.PA);
    dictVP = normalizeDictObject(all.VP);
    dictNames = normalizeDictObject(all.Names);
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

  function translateTextWithMap(text) {
    text = fixVietnamese(text);
    if (!text || !text.trim() || !hasHanChar(text)) return { result: text, tokenMap: [] };
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
          if (pi < parts.length - 1) nextSegments.push({ text: nameVal, han: name, isName: true });
        }
      }
      segments = nextSegments;
    }

    const pairs = [];
    const maxLen = dictVPKeys.length ? dictVPKeys[0].length : 1;

    for (const seg of segments) {
      if (seg.isName) { pairs.push({ han: seg.han, viet: seg.text }); continue; }
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
            pairs.push({ han: sub, viet: t });
            i += j;
            matched = true;
            break;
          }
        }
        if (matched) continue;

        const c = s[i];
        if (!isHanChar(c)) {
          const raw = takeNonHanRun(s, i);
          if (raw) pairs.push({ han: raw, viet: raw });
          i += raw.length || 1;
          continue;
        }
        if (dichlieu && DICH_LIEU_SET.has(c)) { i++; continue; }
        pairs.push({ han: c, viet: dictPA[c] || c });
        i++;
      }
    }

    let result = postProcessTranslatedText(joinTranslatedTokens(pairs.map(pair => pair.viet)));
    result = fixVietnamese(resolvePlaceholders(autoCapitalize(result)));

    const tokenMap = [];
    const searchableResult = result.toLocaleLowerCase('vi-VN');
    let searchFrom = 0;
    for (const pair of pairs) {
      if (!pair.viet) continue;
      const displayViet = fixVietnamese(resolvePlaceholders(pair.viet));
      const searchableViet = displayViet.toLocaleLowerCase('vi-VN');
      let start = searchableResult.indexOf(searchableViet, searchFrom);
      if (start < 0) start = searchableResult.indexOf(searchableViet);
      if (start < 0) continue;
      const end = start + displayViet.length;
      tokenMap.push({ han: pair.han, viet: result.slice(start, end), start, end });
      searchFrom = end;
    }
    return { result, tokenMap };
  }

  const VP_EXCLUDE_IDS = new Set(['_vp_theme_style', '_vp_dict_manager', '_vp_copy_status']);
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
      const translated = chunkTexts.map(text => translateTextWithMap(text));

      if (_translateSession !== session) return;
      chunkArr.forEach((node, i) => {
        node._vpOrigin = node.textContent;
        node.textContent = fixVietnamese(translated[i].result);
        node._vpTranslated = true;
        node._vpTokenMap = translated[i].tokenMap;
        node.parentElement?.classList.add('_vp_translated_parent');
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
          child._vpTokenMap = undefined;
        } else if (child.nodeType === 1) {
          restore(child);
        }
      }
      for (const n of toRemove) n.remove();
      node.classList?.remove('_vp_translated_parent');
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

  function getTokenRanges(node) {
    if (!node || node.nodeType !== 3) return [];
    const textLength = (node.textContent || '').length;
    return (Array.isArray(node._vpTokenMap) ? node._vpTokenMap : []).filter(token =>
      token && token.han && Number.isFinite(token.start) && Number.isFinite(token.end) &&
      token.start >= 0 && token.end > token.start && token.end <= textLength
    );
  }

  function getSelectedHanFromNode(node, startOffset, endOffset) {
    const text = node.textContent || '';
    const start = Math.max(0, Math.min(startOffset, text.length));
    const end = Math.max(start, Math.min(endOffset, text.length));
    if (end <= start) return '';

    if (!node._vpOrigin) {
      const selected = text.slice(start, end);
      return hasHanChar(selected) ? selected : '';
    }

    const ranges = getTokenRanges(node);
    const picked = ranges.filter(token => token.end > start && token.start < end);
    if (picked.length) return picked.map(token => token.han).join('');
    if (start === 0 && end === text.length) return node._vpOrigin;
    return '';
  }

  function rangeIntersectsTextNode(range, node) {
    if (!range || !node || node.nodeType !== 3) return false;
    try {
      if (typeof range.intersectsNode === 'function') return range.intersectsNode(node);
      const nodeRange = document.createRange();
      nodeRange.selectNodeContents(node);
      return !(range.compareBoundaryPoints(Range.START_TO_END, nodeRange) > 0 ||
               range.compareBoundaryPoints(Range.END_TO_START, nodeRange) < 0);
    } catch (_) {
      return false;
    }
  }

  function getRangeOffsets(range, node) {
    if (!rangeIntersectsTextNode(range, node)) return null;
    const textLength = (node.textContent || '').length;
    let start = 0;
    let end = textLength;
    if (range.startContainer === node) start = range.startOffset;
    if (range.endContainer === node) end = range.endOffset;
    start = Math.max(0, Math.min(start, textLength));
    end = Math.max(start, Math.min(end, textLength));
    return { start, end };
  }

  let lastSelectionRange = null;
  let lastSelectedHan = '';

  function extractHanFromRange(range) {
    if (!range || range.collapsed) return '';
    const root = range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    if (!root) return '';

    if (range.startContainer === range.endContainer && range.startContainer.nodeType === 3) {
      return getSelectedHanFromNode(range.startContainer, range.startOffset, range.endOffset).trim();
    }

    const parts = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node._vpSpaceNode) continue;
      const offsets = getRangeOffsets(range, node);
      if (!offsets) continue;
      const han = getSelectedHanFromNode(node, offsets.start, offsets.end);
      if (han) parts.push(han);
    }
    return parts.join('').trim();
  }

  function snapshotSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    try {
      lastSelectionRange = selection.getRangeAt(0).cloneRange();
      lastSelectedHan = extractHanFromRange(lastSelectionRange);
    } catch (_) { /* ignored */ }
  }

  document.addEventListener('selectionchange', () => setTimeout(snapshotSelection, 0), true);
  document.addEventListener('mouseup', () => setTimeout(snapshotSelection, 0), true);
  document.addEventListener('keyup', event => {
    if (event.key === 'Shift' || event.key.startsWith('Arrow')) setTimeout(snapshotSelection, 0);
  }, true);

  function extractSelectedHan() {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
      try {
        lastSelectionRange = selection.getRangeAt(0).cloneRange();
        lastSelectedHan = extractHanFromRange(lastSelectionRange);
        return lastSelectedHan;
      } catch (_) { /* use cached selection below */ }
    }

    if (lastSelectionRange) {
      try {
        const han = extractHanFromRange(lastSelectionRange);
        if (han) {
          lastSelectedHan = han;
          return han;
        }
      } catch (_) { /* use cached Han below */ }
    }
    return lastSelectedHan;
  }

  function showCopyStatus(message, isError = false) {
    document.getElementById('_vp_copy_status')?.remove();
    const status = document.createElement('div');
    status.id = '_vp_copy_status';
    status.textContent = message;
    Object.assign(status.style, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647',
      padding: '10px 14px', borderRadius: '9px', color: '#fff',
      background: isError ? '#dc2626' : '#059669', font: '600 13px system-ui, sans-serif',
      boxShadow: '0 8px 24px rgba(0,0,0,.24)',
    });
    (document.body || document.documentElement).appendChild(status);
    setTimeout(() => status.remove(), 2200);
  }

  function copyOriginalHan() {
    const han = extractSelectedHan();
    if (!han) {
      showCopyStatus('Hãy chọn phần văn bản đã dịch cần sao chép.', true);
      return;
    }
    try {
      GM_setClipboard(han, 'text');
      showCopyStatus('Đã sao chép chữ Hán gốc.');
    } catch (_) {
      navigator.clipboard.writeText(han)
        .then(() => showCopyStatus('Đã sao chép chữ Hán gốc.'))
        .catch(() => showCopyStatus('Không thể ghi vào clipboard.', true));
    }
  }

  function openDictionaryManager() {
    document.getElementById('_vp_dict_manager')?.remove();

    const overlay = document.createElement('div');
    overlay.id = '_vp_dict_manager';
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', zIndex: '2147483647', display: 'grid',
      placeItems: 'center', padding: '16px', background: 'rgba(15, 23, 42, .55)',
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    });

    const panel = document.createElement('div');
    Object.assign(panel.style, {
      width: 'min(520px, 100%)', padding: '20px', borderRadius: '14px',
      background: '#fff', color: '#0f172a', boxShadow: '0 24px 64px rgba(0,0,0,.28)',
    });

    const title = document.createElement('h2');
    title.textContent = 'Từ điển cá nhân';
    Object.assign(title.style, { margin: '0 0 6px', fontSize: '20px' });
    panel.appendChild(title);

    const description = document.createElement('p');
    description.textContent = 'Tải file TXT dạng Hán=Việt. Dữ liệu được Tampermonkey lưu dùng chung cho mọi website.';
    Object.assign(description.style, { margin: '0 0 16px', color: '#475569', fontSize: '14px', lineHeight: '1.5' });
    panel.appendChild(description);

    const meta = gmGet(DICT_META_KEY, {});
    for (const dictKey of DICT_TYPES) {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'grid', gridTemplateColumns: '72px 1fr auto', alignItems: 'center',
        gap: '10px', padding: '11px 0', borderTop: '1px solid #e2e8f0',
      });

      const name = document.createElement('strong');
      name.textContent = dictKey;
      const status = document.createElement('span');
      const info = meta && typeof meta === 'object' ? meta[dictKey] : null;
      const stored = getStoredDict(dictKey);
      const count = stored ? Object.keys(stored).length : 0;
      status.textContent = count
        ? `${count.toLocaleString('vi-VN')} mục · ${info?.source === 'user' ? 'cá nhân' : 'mặc định'}`
        : 'Chưa có dữ liệu';
      Object.assign(status.style, { color: '#64748b', fontSize: '13px' });

      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.txt,text/plain';
      input.hidden = true;

      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Tải lên';
      Object.assign(button.style, {
        border: '0', borderRadius: '8px', padding: '8px 12px', cursor: 'pointer',
        background: '#4f46e5', color: '#fff', fontWeight: '600',
      });
      button.onclick = () => input.click();
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        button.disabled = true;
        status.textContent = 'Đang đọc và lưu…';
        try {
          const parsed = parseDict(await file.text(), dictKey === 'PA' ? 'PA' : '');
          saveStoredDict(dictKey, parsed, 'user');
          await loadDicts();
          status.textContent = `${Object.keys(parsed).length.toLocaleString('vi-VN')} mục · cá nhân`;
          restoreAndRetranslate();
        } catch (err) {
          status.textContent = `Lỗi: ${err.message || err}`;
          console.warn(`[VP Lite] Upload ${dictKey} thất bại:`, err);
        } finally {
          button.disabled = false;
          input.value = '';
        }
      };

      row.append(name, status, button, input);
      panel.appendChild(row);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Đóng';
    Object.assign(close.style, {
      display: 'block', margin: '16px 0 0 auto', border: '1px solid #cbd5e1',
      borderRadius: '8px', padding: '8px 14px', cursor: 'pointer', background: '#fff', color: '#0f172a',
    });
    close.onclick = () => overlay.remove();
    panel.appendChild(close);
    overlay.appendChild(panel);
    overlay.onclick = event => { if (event.target === overlay) overlay.remove(); };
    (document.body || document.documentElement).appendChild(overlay);
  }

  GM_registerMenuCommand('▶ Dịch trang', () => realtimeTranslate(true));
  GM_registerMenuCommand('🔄 Làm mới bản dịch', () => restoreAndRetranslate());
  GM_registerMenuCommand('📋 Sao chép chữ Hán gốc', () => copyOriginalHan());
  GM_registerMenuCommand('📚 Từ điển cá nhân', () => openDictionaryManager());

  (async function init() {
    injectVietnameseStyle();
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
