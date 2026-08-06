// ==UserScript==
// @name         Vietphrase Realtime Translator Lite
// @namespace    https://github.com/duongden/script-vietphrase-translator
// @version      2.3.0
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
/* Vietphrase QuickTranslate-compatible rule engine. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.VPRuleEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const NUM_DIGITS = Object.freeze({
    '零': 0, '〇': 0, '○': 0, '〇': 0,
    '一': 1, '二': 2, '两': 2, '兩': 2, '三': 3, '四': 4,
    '五': 5, '六': 6, '七': 7, '八': 8, '九': 9
  });
  const SMALL_UNITS = Object.freeze({ '十': 10, '百': 100, '千': 1000 });
  const LARGE_UNITS = Object.freeze({ '万': 10000, '萬': 10000, '亿': 100000000, '億': 100000000 });
  const NUMERIC_RE = /^[0-9零〇○一二两兩三四五六七八九十百千万萬亿億]+/;
  const YEAR_RE = /^[0-9零〇○一二两兩三四五六七八九]+/;
  const NUMERIC_CHAR_RE = /[0-9零〇○一二两兩三四五六七八九十百千万萬亿億]/;
  const NUMERIC_GROUP_SEPARATOR_RE = /[,，]/;
  const LABELS = Object.freeze({
    '章': 'Chương', '卷': 'Quyển', '集': 'Tập', '节': 'Tiết',
    '節': 'Tiết', '幕': 'Màn', '回': 'Hồi', '折': 'Chiết'
  });
  const COMMON_ANCHORS = new Set('的了是不在');

  function firstMeaning(value, separator) {
    const text = String(value == null ? '' : value);
    const separators = [separator || '/', '¦'];
    let end = text.length;
    for (const sep of separators) {
      if (!sep) continue;
      const at = text.indexOf(sep);
      if (at >= 0 && at < end) end = at;
    }
    return text.slice(0, end).trim();
  }

  function digitOf(ch) {
    if (/[0-9]/.test(ch)) return Number(ch);
    return Object.prototype.hasOwnProperty.call(NUM_DIGITS, ch) ? NUM_DIGITS[ch] : null;
  }

  function yearToLatin(raw) {
    let out = '';
    for (const ch of raw) {
      const digit = digitOf(ch);
      if (digit == null) return null;
      out += digit;
    }
    return out;
  }

  function chineseToLatin(raw) {
    if (/^[0-9]+$/.test(raw)) return String(Number(raw));
    if (!/[十百千万萬亿億]/.test(raw)) return yearToLatin(raw);
    let total = 0;
    let section = 0;
    let number = 0;
    let saw = false;
    for (const ch of raw) {
      const digit = digitOf(ch);
      if (digit != null) {
        number = digit;
        saw = true;
        continue;
      }
      const small = SMALL_UNITS[ch];
      if (small) {
        section += (number || 1) * small;
        number = 0;
        saw = true;
        continue;
      }
      const large = LARGE_UNITS[ch];
      if (large) {
        section += number;
        total += (section || 1) * large;
        section = 0;
        number = 0;
        saw = true;
        continue;
      }
      return null;
    }
    return saw ? String(total + section + number) : null;
  }

  function parseRange(raw, defaultMax) {
    if (!raw) return { min: 1, max: defaultMax };
    const match = /^(\d+)(?:-(\d+))?$/.exec(raw);
    if (!match) throw new Error('range không hợp lệ');
    const min = Number(match[1]);
    const max = Number(match[2] || match[1]);
    if (min < 1 || max < min || max > 64) throw new Error('range không hợp lệ');
    return { min, max };
  }

  function parseCapture(raw) {
    const split = raw.split(':');
    if (split.length > 2) throw new Error('token không hợp lệ');
    const sources = split[0].split('|');
    if (!sources.length || sources.some(s => !['n', 'y', 'L', 'ne', 'pn', 'vp', 'hv', 'w'].includes(s))) {
      throw new Error(`token lạ: <${raw}>`);
    }
    const fixed = sources.length === 1 && (sources[0] === 'L' || sources[0] === 'hv');
    const range = parseRange(split[1], fixed ? 1 : 12);
    if (fixed && (range.min !== 1 || range.max !== 1)) throw new Error(`token <${sources[0]}> chỉ nhận 1 ký tự`);
    return { type: 'capture', sources, min: range.min, max: range.max };
  }

  function parseGroup(pattern, start) {
    let end = start + 1;
    let escaped = false;
    for (; end < pattern.length; end++) {
      const ch = pattern[end];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === ')') break;
    }
    if (end >= pattern.length) throw new Error('thiếu dấu )');
    const body = pattern.slice(start + 1, end);
    const alternatives = body.split('|').map(s => s.replace(/\\([|()])/g, '$1'));
    if (alternatives.some(s => !s)) throw new Error('nhóm rỗng');
    const optional = pattern[end + 1] === '?';
    return { token: { type: 'group', alternatives, optional }, end: end + (optional ? 2 : 1) };
  }

  function parsePattern(pattern) {
    const tokens = [];
    let literal = '';
    const flush = () => {
      if (literal) tokens.push({ type: 'literal', value: literal });
      literal = '';
    };
    for (let i = 0; i < pattern.length;) {
      if (pattern[i] === '<') {
        flush();
        const end = pattern.indexOf('>', i + 1);
        if (end < 0) throw new Error('thiếu dấu >');
        tokens.push(parseCapture(pattern.slice(i + 1, end)));
        i = end + 1;
      } else if (pattern[i] === '(') {
        flush();
        const group = parseGroup(pattern, i);
        tokens.push(group.token);
        i = group.end;
      } else {
        literal += pattern[i++];
      }
    }
    flush();
    return tokens;
  }

  function getAnchor(tokens) {
    const candidates = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type === 'literal' && token.value) candidates.push({ value: token.value, tokenIndex: i });
      if (token.type === 'group' && !token.optional) {
        for (const value of token.alternatives) candidates.push({ value, tokenIndex: i });
      }
    }
    candidates.sort((a, b) => {
      const commonA = a.value.length === 1 && COMMON_ANCHORS.has(a.value) ? 1 : 0;
      const commonB = b.value.length === 1 && COMMON_ANCHORS.has(b.value) ? 1 : 0;
      return commonA - commonB || b.value.length - a.value.length;
    });
    return candidates[0] || null;
  }

  function compileRule(pattern, translation, line) {
    const tokens = parsePattern(pattern);
    const captures = tokens.filter(t => t.type === 'capture');
    const anchor = getAnchor(tokens);
    if (!anchor) throw new Error('rule không có neo');
    if (!captures.length) throw new Error('rule không có wildcard');
    let used = new Set();
    translation.replace(/\{(\d+)\}/g, (_m, n) => { used.add(Number(n)); return _m; });
    if ([...used].some(n => n >= captures.length)) throw new Error('placeholder không tồn tại');
    if (captures.some((_c, i) => !used.has(i))) throw new Error('capture không được dùng');
    const specificity = tokens.reduce((sum, token) => {
      if (token.type === 'literal') return sum + token.value.length;
      if (token.type === 'group') return sum + Math.max(...token.alternatives.map(s => s.length));
      return sum + token.max;
    }, 0);
    return { pattern, translation, line, tokens, anchor, specificity, wildcardCount: captures.length };
  }

  function parseRules(text) {
    const rules = [];
    const errors = [];
    const seen = new Set();
    String(text || '').split(/\r?\n/).forEach((raw, index) => {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) return;
      const eq = line.indexOf('=');
      if (eq < 1) { errors.push({ line: index + 1, reason: 'thiếu dấu =', source: raw }); return; }
      const pattern = line.slice(0, eq).trim();
      const translation = line.slice(eq + 1).trim();
      if (!translation) { errors.push({ line: index + 1, reason: 'bản dịch rỗng', source: raw }); return; }
      if (seen.has(pattern)) { errors.push({ line: index + 1, reason: 'duplicate', source: raw }); return; }
      try {
        rules.push(compileRule(pattern, translation, index + 1));
        seen.add(pattern);
      } catch (error) {
        errors.push({ line: index + 1, reason: error.message, source: raw });
      }
    });
    rules.sort((a, b) => b.specificity - a.specificity || a.wildcardCount - b.wildcardCount || a.pattern.localeCompare(b.pattern));
    return { rules, errors };
  }

  function lookupSource(source, raw, dictionaries, separator) {
    if (source === 'n') {
      if (!NUMERIC_RE.test(raw) || NUMERIC_RE.exec(raw)[0] !== raw) return null;
      return chineseToLatin(raw);
    }
    if (source === 'y') {
      if (!YEAR_RE.test(raw) || YEAR_RE.exec(raw)[0] !== raw) return null;
      return yearToLatin(raw);
    }
    if (source === 'L') return raw.length === 1 ? LABELS[raw] || null : null;
    if (source === 'hv') {
      if (raw.length !== 1 || dictionaries.pa[raw] == null) return null;
      return firstMeaning(dictionaries.pa[raw], separator);
    }
    const dictOrder = source === 'ne' ? [dictionaries.names]
      : source === 'pn' ? [dictionaries.pronouns]
      : source === 'vp' ? [dictionaries.vp]
      : [dictionaries.names, dictionaries.pronouns, dictionaries.vp];
    for (const dict of dictOrder) {
      if (dict && dict[raw] != null) return firstMeaning(dict[raw], separator);
    }
    return null;
  }

  function captureMatches(token, text, position, dictionaries, separator) {
    const available = Math.min(token.max, text.length - position);
    const matches = [];
    for (const source of token.sources) {
      for (let len = available; len >= token.min; len--) {
        const raw = text.slice(position, position + len);
        const value = lookupSource(source, raw, dictionaries, separator);
        if (value != null) matches.push({ len, raw, value });
      }
      if (matches.length) break;
    }
    return matches;
  }

  function matchRule(rule, text, start, dictionaries, separator) {
    function walk(tokenIndex, position, captures) {
      if (tokenIndex === rule.tokens.length) return { end: position, captures };
      const token = rule.tokens[tokenIndex];
      if (token.type === 'literal') {
        return text.startsWith(token.value, position)
          ? walk(tokenIndex + 1, position + token.value.length, captures) : null;
      }
      if (token.type === 'group') {
        for (const value of token.alternatives) {
          if (!text.startsWith(value, position)) continue;
          const hit = walk(tokenIndex + 1, position + value.length, captures);
          if (hit) return hit;
        }
        return token.optional ? walk(tokenIndex + 1, position, captures) : null;
      }
      for (const candidate of captureMatches(token, text, position, dictionaries, separator)) {
        const hit = walk(tokenIndex + 1, position + candidate.len, captures.concat(candidate));
        if (hit) return hit;
      }
      return null;
    }
    const hit = walk(0, start, []);
    if (!hit || hit.end <= start) return null;
    const first = rule.tokens[0];
    const last = rule.tokens[rule.tokens.length - 1];
    const continuesNumberBefore = start > 0 && (
      NUMERIC_CHAR_RE.test(text[start - 1]) ||
      (start > 1 && NUMERIC_GROUP_SEPARATOR_RE.test(text[start - 1]) && NUMERIC_CHAR_RE.test(text[start - 2]))
    );
    const continuesNumberAfter = hit.end < text.length && (
      NUMERIC_CHAR_RE.test(text[hit.end]) ||
      (hit.end + 1 < text.length && NUMERIC_GROUP_SEPARATOR_RE.test(text[hit.end]) && NUMERIC_CHAR_RE.test(text[hit.end + 1]))
    );
    if (first.type === 'capture' && first.sources.some(s => s === 'n' || s === 'y') && continuesNumberBefore) return null;
    if (last.type === 'capture' && last.sources.some(s => s === 'n' || s === 'y') && continuesNumberAfter) return null;
    let translation = rule.translation;
    hit.captures.forEach((capture, index) => { translation = translation.split(`{${index}}`).join(capture.value); });
    return { start, end: hit.end, source: text.slice(start, hit.end), translation, pattern: rule.pattern, line: rule.line };
  }

  function normalizeDict(data) {
    return data && typeof data === 'object' ? data : {};
  }

  function create(ruleText, inputDictionaries, options) {
    const parsed = parseRules(ruleText);
    const dictionaries = {
      pa: normalizeDict(inputDictionaries && inputDictionaries.pa),
      vp: normalizeDict(inputDictionaries && inputDictionaries.vp),
      names: normalizeDict(inputDictionaries && inputDictionaries.names),
      pronouns: normalizeDict(inputDictionaries && inputDictionaries.pronouns)
    };
    const separator = options && options.separator || '/';
    const direct = new Map();
    const wildcardFirst = [];
    const wildcardIndex = new Map();
    let maxWildcardPrefix = 0;
    for (let ruleOrder = 0; ruleOrder < parsed.rules.length; ruleOrder++) {
      const rule = parsed.rules[ruleOrder];
      rule.order = ruleOrder;
      const first = rule.tokens[0];
      if (first.type === 'literal' && first.value) {
        const key = first.value[0];
        if (!direct.has(key)) direct.set(key, []);
        direct.get(key).push(rule);
      } else if (first.type === 'group' && !first.optional) {
        for (const alt of first.alternatives) {
          const key = alt[0];
          if (!direct.has(key)) direct.set(key, []);
          direct.get(key).push(rule);
        }
      } else {
        wildcardFirst.push(rule);
        let minOffset = 0;
        let maxOffset = 0;
        let anchors = null;
        for (const token of rule.tokens) {
          if (token.type === 'literal' && token.value) { anchors = [token.value]; break; }
          if (token.type === 'group' && !token.optional) { anchors = token.alternatives; break; }
          if (token.type === 'capture') { minOffset += token.min; maxOffset += token.max; }
          else if (token.type === 'group' && token.optional) maxOffset += Math.max(...token.alternatives.map(s => s.length));
        }
        if (anchors) {
          maxWildcardPrefix = Math.max(maxWildcardPrefix, maxOffset);
          for (const anchor of anchors) {
            const key = anchor[0];
            if (!wildcardIndex.has(key)) wildcardIndex.set(key, []);
            wildcardIndex.get(key).push({ rule, anchor, minOffset, maxOffset });
          }
        }
      }
    }

    function longestVPAt(text, start) {
      const max = Math.min(text.length - start, options && options.vpMaxLen || 64);
      for (let len = max; len > 0; len--) if (dictionaries.vp[text.slice(start, start + len)] != null) return len;
      return 0;
    }

    function matchAt(text, start) {
      const candidates = (direct.get(text[start]) || []).slice();
      const seen = new Set(candidates);
      const lookaheadEnd = Math.min(text.length - start - 1, maxWildcardPrefix);
      for (let offset = 1; offset <= lookaheadEnd; offset++) {
        const indexed = wildcardIndex.get(text[start + offset]);
        if (!indexed) continue;
        for (const item of indexed) {
          if (offset < item.minOffset || offset > item.maxOffset || seen.has(item.rule)) continue;
          if (!text.startsWith(item.anchor, start + offset)) continue;
          seen.add(item.rule);
          candidates.push(item.rule);
        }
      }
      // Defensive fallback for a future wildcard-only syntax. Current validation
      // requires a literal anchor, so this normally remains empty.
      if (!wildcardIndex.size) candidates.push(...wildcardFirst);
      candidates.sort((a, b) => a.order - b.order);
      for (const rule of candidates) {
        const hit = matchRule(rule, text, start, dictionaries, separator);
        if (!hit) continue;
        const vpLength = longestVPAt(text, start);
        if (vpLength >= hit.end - start) continue;
        return hit;
      }
      return null;
    }

    return { matchAt, rules: parsed.rules, errors: parsed.errors };
  }

  return { create, parseRules, chineseToLatin, yearToLatin, LABELS };
});

(function () {
  'use strict';

  const CHINESE_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3007]/;
  const DICH_LIEU_SET = new Set(['的', '了', '着', '著']);
  const DICT_TYPES = ['PA', 'VP', 'Names', 'Pronouns'];
  const MANAGER_TYPES = ['PA', 'VP', 'Names', 'Pronouns', 'Rules'];
  const DICT_STORAGE_PREFIX = 'vp_lite_dict_';
  const DICT_META_KEY = 'vp_lite_dict_meta';
  const RULE_STORAGE_KEY = 'vp_lite_rules';
  const DEFAULT_DICT_URLS = {
    PA: 'https://raw.githubusercontent.com/duongden/script-vietphrase-translator/refs/heads/main/ChinesePhienAmWords.txt',
    VP: 'https://raw.githubusercontent.com/duongden/script-vietphrase-translator/refs/heads/main/Vietphrase.txt',
    Names: 'https://raw.githubusercontent.com/duongden/script-vietphrase-translator/refs/heads/main/Names.txt',
    Pronouns: 'https://raw.githubusercontent.com/duongden/script-vietphrase-translator/refs/heads/main/Pronouns.txt',
    Rules: 'https://raw.githubusercontent.com/duongden/script-vietphrase-translator/refs/heads/main/rule.txt'
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
  let dictPronouns = {};
  let ruleText = '';
  let ruleEngine = null;
  let dictVPKeys = [];
  let dictNamesKeys = [];
  let dictVPMaxLen = 1;
  let dictNamesMaxLen = 0;
  let isLoaded = false;

  const settings = {
    ngoac: false,
    motnghia: true,
    daucach: '/',
    dichlieu: true,
    ruleEnabled: true,
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
    if (dictKey === 'Rules') return fixVietnamese(text);
    return parseDict(text, dictKey === 'PA' ? 'PA' : '');
  }

  async function ensureBaseDicts() {
    const merged = {};
    for (const key of DICT_TYPES) merged[key] = getStoredDict(key);
    const storedRules = fixVietnamese(gmGet(RULE_STORAGE_KEY, ''));
    if (storedRules.trim()) merged.Rules = storedRules;
    const missing = ['PA', 'VP', 'Names', 'Pronouns', 'Rules'].filter(key => !merged[key]);

    const fetched = await Promise.all(missing.map(async key => {
      const parsed = await fetchDefaultDict(key);
      // Người dùng có thể upload trong lúc request mặc định đang chạy.
      const current = key === 'Rules' ? fixVietnamese(gmGet(RULE_STORAGE_KEY, '')) : getStoredDict(key);
      if (current) return [key, current];
      if (key === 'Rules') gmSet(RULE_STORAGE_KEY, parsed);
      else saveStoredDict(key, parsed, 'default');
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
    dictPronouns = normalizeDictObject(all.Pronouns);
    ruleText = fixVietnamese(all.Rules || gmGet(RULE_STORAGE_KEY, ''));
    dictVPKeys = sortByLenDesc(dictVP);
    dictNamesKeys = sortByLenDesc(dictNames);
    dictVPMaxLen = dictVPKeys.length ? dictVPKeys[0].length : 1;
    dictNamesMaxLen = dictNamesKeys.length ? dictNamesKeys[0].length : 0;
    ruleEngine = globalThis.VPRuleEngine ? globalThis.VPRuleEngine.create(ruleText, {
      pa: dictPA,
      vp: dictVP,
      names: dictNames,
      pronouns: dictPronouns
    }, { separator: settings.daucach, vpMaxLen: dictVPMaxLen }) : null;
    isLoaded = true;
    console.log(`[VP Lite] PA=${Object.keys(dictPA).length} VP=${dictVPKeys.length} Names=${dictNamesKeys.length} Pronouns=${Object.keys(dictPronouns).length} Rules=${ruleEngine ? ruleEngine.rules.length : 0}`);
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
    ['；', ';'], ['：', ':'], ['，', ','], ['、', ', '],
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

  function normalizeTokenCase(pairs) {
    let context = '';
    for (const pair of pairs) {
      let value = String(pair.viet || '');
      const startsSentence = !context.trim() || /[.!?]\s*$/.test(context) || /\x02\s*$/.test(context);
      if (!startsSentence && pair.type !== 'name' && /^[A-ZÀ-ỸĐ]/.test(value)) {
        value = value[0].toLowerCase() + value.slice(1);
        pair.viet = value;
      }
      context = joinTranslatedTokens([context, value]);
    }
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
      .replace(/(^|[^0-9]),(?=[0-9])/g, '$1, ')
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

  function takeNameSegments(text) {
    if (!dictNamesMaxLen) return [{ text, isName: false }];
    const segments = [];
    let plainStart = 0;
    let i = 0;

    while (i < text.length) {
      let name = '';
      const remaining = text.length - i;
      for (let len = Math.min(dictNamesMaxLen, remaining); len > 0; len--) {
        const candidate = text.slice(i, i + len);
        if (dictNames[candidate] !== undefined) {
          name = candidate;
          break;
        }
      }

      if (!name) {
        i++;
        continue;
      }

      let vpLength = 0;
      for (let len = Math.min(dictVPMaxLen, remaining); len >= name.length; len--) {
        if (dictVP[text.slice(i, i + len)] !== undefined) { vpLength = len; break; }
      }
      if (vpLength >= name.length) {
        i++;
        continue;
      }

      if (plainStart < i) {
        segments.push({ text: text.slice(plainStart, i), isName: false });
      }
      let nameVal = dictNames[name];
      nameVal = settings.motnghia
        ? nameVal.split(settings.daucach)[0].trim()
        : nameVal.trim();
      if (settings.ngoac) nameVal = '[' + nameVal + ']';
      segments.push({ text: nameVal, han: name, isName: true });
      i += name.length;
      plainStart = i;
    }

    if (plainStart < text.length) {
      segments.push({ text: text.slice(plainStart), isName: false });
    }
    return segments;
  }

  function translateTextWithMap(text) {
    text = fixVietnamese(text);
    if (!text || !text.trim() || !hasHanChar(text)) return { result: text, tokenMap: [] };
    const { ngoac, motnghia, daucach, dichlieu } = settings;
    text = normalizePunct(text);

    const ruleSegments = [];
    if (settings.ruleEnabled !== false && ruleEngine && ruleEngine.rules.length) {
      let plainStart = 0;
      let cursor = 0;
      while (cursor < text.length) {
        const hit = ruleEngine.matchAt(text, cursor);
        if (!hit) { cursor++; continue; }
        if (plainStart < cursor) ruleSegments.push({ text: text.slice(plainStart, cursor) });
        ruleSegments.push({ text: hit.translation, han: hit.source, isRule: true });
        cursor = hit.end;
        plainStart = cursor;
      }
      if (plainStart < text.length) ruleSegments.push({ text: text.slice(plainStart) });
    } else {
      ruleSegments.push({ text });
    }
    const segments = [];
    for (const segment of ruleSegments) {
      if (segment.isRule) segments.push(segment);
      else segments.push(...takeNameSegments(segment.text));
    }

    const pairs = [];
    const maxLen = dictVPMaxLen;

    for (const seg of segments) {
      if (seg.isRule) { pairs.push({ han: seg.han, viet: seg.text }); continue; }
      if (seg.isName) { pairs.push({ han: seg.han, viet: seg.text, type: 'name' }); continue; }
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

    normalizeTokenCase(pairs);
    let result = postProcessTranslatedText(joinTranslatedTokens(pairs.map(pair => pair.viet)));
    const tokenMap = [];
    let searchFrom = 0;
    for (const pair of pairs) {
      if (!pair.viet) continue;
      let start = result.indexOf(pair.viet, searchFrom);
      if (start < 0) start = result.indexOf(pair.viet);
      if (start < 0) continue;
      const end = start + pair.viet.length;
      tokenMap.push({ han: pair.han, viet: pair.viet, start, end });
      searchFrom = end;
    }
    result = fixVietnamese(resolvePlaceholders(autoCapitalize(result)));
    for (const token of tokenMap) {
      token.viet = result.slice(token.start, token.end);
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

  function getRangeOffsets(range, node) {
    try {
      const nodeRange = document.createRange();
      nodeRange.selectNodeContents(node);
      if (range.compareBoundaryPoints(Range.END_TO_START, nodeRange) <= 0 ||
          range.compareBoundaryPoints(Range.START_TO_END, nodeRange) >= 0) return null;
      let start = 0;
      let end = (node.textContent || '').length;
      if (range.startContainer === node) start = range.startOffset;
      if (range.endContainer === node) end = range.endOffset;
      return { start, end };
    } catch (_) {
      return null;
    }
  }

  function extractHanFromRange(range) {
    if (!range || range.collapsed) return '';
    if (range.startContainer === range.endContainer && range.startContainer.nodeType === 3) {
      return getSelectedHanFromNode(
        range.startContainer,
        range.startOffset,
        range.endOffset
      ).trim();
    }

    const root = range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    if (!root) return '';

    const parts = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node._vpSpaceNode) continue;
      if (typeof range.intersectsNode === 'function' && !range.intersectsNode(node)) continue;

      let start = 0;
      let end = (node.textContent || '').length;
      if (range.startContainer === node) start = range.startOffset;
      if (range.endContainer === node) end = range.endOffset;

      const han = getSelectedHanFromNode(node, start, end);
      if (han) parts.push(han);
    }
    return parts.join('').trim();
  }

  let lastSelectionRange = null;
  function snapshotSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    try { lastSelectionRange = selection.getRangeAt(0).cloneRange(); } catch (_) { /* ignored */ }
  }

  document.addEventListener('selectionchange', () => setTimeout(snapshotSelection, 0), true);
  document.addEventListener('mouseup', () => setTimeout(snapshotSelection, 0), true);
  document.addEventListener('keyup', event => {
    if (event.key === 'Shift' || event.key.startsWith('Arrow')) setTimeout(snapshotSelection, 0);
  }, true);

  function extractSelectedHan() {
    const selection = window.getSelection();
    let range = null;
    if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
      range = selection.getRangeAt(0).cloneRange();
      lastSelectionRange = range.cloneRange();
    } else if (lastSelectionRange) {
      range = lastSelectionRange.cloneRange();
    }
    if (!range) return '';

    return extractHanFromRange(range);
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
    for (const dictKey of MANAGER_TYPES) {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'grid', gridTemplateColumns: '72px 1fr auto', alignItems: 'center',
        gap: '10px', padding: '11px 0', borderTop: '1px solid #e2e8f0',
      });

      const name = document.createElement('strong');
      name.textContent = dictKey;
      const status = document.createElement('span');
      const info = meta && typeof meta === 'object' ? meta[dictKey] : null;
      const stored = dictKey === 'Rules' ? gmGet(RULE_STORAGE_KEY, '') : getStoredDict(dictKey);
      const count = dictKey === 'Rules'
        ? (globalThis.VPRuleEngine ? globalThis.VPRuleEngine.parseRules(stored || '').rules.length : 0)
        : stored ? Object.keys(stored).length : 0;
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
          const uploadedText = await file.text();
          const parsed = dictKey === 'Rules' ? fixVietnamese(uploadedText) : parseDict(uploadedText, dictKey === 'PA' ? 'PA' : '');
          if (dictKey === 'Rules') gmSet(RULE_STORAGE_KEY, parsed);
          else saveStoredDict(dictKey, parsed, 'user');
          await loadDicts();
          const parsedCount = dictKey === 'Rules' ? (ruleEngine ? ruleEngine.rules.length : 0) : Object.keys(parsed).length;
          status.textContent = `${parsedCount.toLocaleString('vi-VN')} mục · cá nhân`;
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
  GM_registerMenuCommand('⚙ Bật / tắt Rule.txt', () => {
    settings.ruleEnabled = !settings.ruleEnabled;
    const stored = gmGet('vp_lite_options', {});
    gmSet('vp_lite_options', { ...(stored && typeof stored === 'object' ? stored : {}), ruleEnabled: settings.ruleEnabled });
    restoreAndRetranslate();
  });

  (async function init() {
    injectVietnameseStyle();
    const stored = gmGet('vp_lite_options', null);
    if (stored && typeof stored === 'object') {
      // Chỉ lấy settings không liên quan đến bật/tắt từ storage
      const safeKeys = ['ngoac', 'motnghia', 'daucach', 'dichlieu', 'ruleEnabled', 'heightauto', 'scaleauto', 'delayMutation', 'delayTrans'];
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
