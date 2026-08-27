import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';

const MODULE = 'yuyu_reasoning_watchdog';
const EXTENSION_FOLDER = decodeURIComponent(new URL('.', import.meta.url).pathname.split('/').filter(Boolean).pop() || 'Yuyu-Reasoning-Watchdog-v0.3.1');
const POLL_MS = 520;
const MAX_HISTORY = 12;
const MAX_SAMPLES = 42;
let toolbarPollTimer = null;
let watchdogPopup = null;
let popupRoot = null;
let floatEl = null;

const GUIDE_MAX_CHARS = 1200;
const FIXED_THINKING_GUIDE = `【思维监工｜本轮内部检查】
不要逐题展开，只在内部核对：
1. 哪些事实已经成立，不必重新判定？
2. 还剩哪个具体未决变量会影响本轮推进？
3. 角色此刻的理解、情绪与行动，是否有既有设定、已知信息与当前动机支持？
4. 是否把一次情境反应放大成稳定人格，或为了推进剧情临时提高角色强度？
5. 最近一段推理增加了什么新信息，还是只在换说法重复已有结论？
6. 若已无具体未决变量，结束分析并完成本轮输出。
不要在最终输出中复述本检查题。`;

const defaults = {
    enabled: true,
    toolbarEnabled: true,
    floatEnabled: false,
    floatOpacity: 35,
    toastEnabled: true,
    sensitivity: 'balanced',
    thinkingGuideEnabled: true,
    thinkingGuideMode: 'fixed',
    customThinkingGuide: '',
    floatTopPct: 42,
    history: [],
};

const runtime = {
    active: false,
    startedAt: 0,
    reasoningStartedAt: 0,
    reasoningDoneAt: 0,
    lastReasoningChangedAt: 0,
    timer: null,
    lastReasoning: '',
    lastReasoningChars: 0,
    latestBodyChars: 0,
    latestMessageId: null,
    analysis: emptyAnalysis(),
    samples: [],
    lastAlertLevel: 'normal',
    lastToastAt: 0,
    finalizing: false,
    guideInjectedThisRun: false,
    lastGuideInjectedAt: 0,
    lastGuideText: '',
    reportedThinkingTokens: null,
    reportedTokenSource: '',
    baselineAssistantId: null,
    baselineAssistantMes: '',
};

const META_WORDS = new Set([
    'analyzing','analysis','assessing','assessment','processing','process','refining','refinement','describing','description',
    'confronting','acknowledging','observing','examining','registering','exploring','reviewing','considering','focusing','integrating',
    'evaluating','establishing','synthesizing','developing','clarifying','revisiting','recognizing','ensuring','maintaining','finalizing',
    'determining','checking','understanding','noting','mapping','framing','constructing','building','balancing','reassessing','continuing',
    'current','immediate','further','deeper','ongoing','narrative','scene','details','detail','elements','element','context','state'
]);

const STOP_WORDS = new Set([
    'the','and','for','with','that','this','from','into','onto','over','under','through','while','where','when','what','which','who',
    'their','there','these','those','then','than','have','has','had','will','would','should','could','about','after','before','during',
    'within','without','between','across','being','been','are','was','were','is','it','its','to','of','in','on','at','as','by','or',
    'a','an','we','i','he','she','they','you','his','her','our','my','your','them','him','also','still','now','already','more','most'
]);

const TOPIC_CANON = new Map([
    ['evidence','aftermath'], ['proof','aftermath'], ['trace','aftermath'], ['traces','aftermath'], ['remnant','aftermath'],
    ['remnants','aftermath'], ['consequence','aftermath'], ['consequences','aftermath'], ['aftermath','aftermath'],
    ['ramification','aftermath'], ['ramifications','aftermath'], ['reality','aftermath'], ['disruption','aftermath'],
    ['physical','physical'], ['bodily','physical'], ['body','physical'], ['somatic','physical'],
    ['emotion','emotion'], ['emotional','emotion'], ['feeling','emotion'], ['feelings','emotion'],
    ['motive','motivation'], ['motives','motivation'], ['motivation','motivation'], ['intent','motivation'], ['intention','motivation'],
    ['reaction','reaction'], ['reactions','reaction'], ['response','reaction'], ['responses','reaction'],
    ['mode','mode'], ['classification','mode'], ['classifying','mode'],
]);

function currentThinkingGuide() {
    const s = settings();
    if (!s.thinkingGuideEnabled) return '';
    if (s.thinkingGuideMode === 'custom') {
        const custom = String(s.customThinkingGuide || '').trim().slice(0, GUIDE_MAX_CHARS);
        return custom || FIXED_THINKING_GUIDE;
    }
    return FIXED_THINKING_GUIDE;
}

function updateGuideSettingsUI() {
    const s = settings();
    const enabled = !!s.thinkingGuideEnabled;
    const mode = String(s.thinkingGuideMode || 'fixed');
    const preview = currentThinkingGuide();
    $('#yrw_thinking_guide_enabled').prop('checked', enabled);
    $('#yrw_thinking_guide_mode').val(mode);
    $('#yrw_custom_guide_wrap').toggle(enabled && mode === 'custom');
    $('#yrw_custom_thinking_guide').val(String(s.customThinkingGuide || ''));
    $('#yrw_guide_preview').val(preview);
    const status = $('#yrw_guide_status');
    if (status.length) {
        if (!enabled) status.text('关闭');
        else if (runtime.lastGuideInjectedAt) {
            const time = new Date(runtime.lastGuideInjectedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            status.text(`已注入 · ${time}`);
        } else status.text('已启用 · 等待下一次生成');
    }
}

function injectThinkingGuide(event) {
    const s = settings();
    if (!s.enabled || !s.thinkingGuideEnabled || event?.dryRun) return;
    const chat = event?.chat;
    if (!Array.isArray(chat)) return;

    const guide = currentThinkingGuide();
    if (!guide) return;
    if (chat.some(m => m?.role === 'system' && String(m?.content || '') === guide)) return;

    // Keep the one-shot guide among the leading system messages. It only
    // mutates the request-ready chat array and is never written to chat history.
    let insertAt = 0;
    while (insertAt < chat.length && chat[insertAt]?.role === 'system') insertAt++;
    chat.splice(insertAt, 0, { role: 'system', content: guide });

    runtime.guideInjectedThisRun = true;
    runtime.lastGuideInjectedAt = Date.now();
    runtime.lastGuideText = guide;
    updateGuideSettingsUI();
    console.debug('[YRW] Injected one-shot thinking guide into request-ready chat.');
}


function numericTokenValue(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
    if (typeof value !== 'string') return null;
    const n = Number(value.replace(/,/g, '').trim());
    return Number.isFinite(n) ? Math.round(n) : null;
}

function findThinkingTokensInObject(obj, depth = 0, seen = new Set()) {
    if (!obj || typeof obj !== 'object' || depth > 4 || seen.has(obj)) return null;
    seen.add(obj);
    const exactKeys = new Set([
        'thoughtstokencount','thought_token_count','thoughttokens','thought_tokens',
        'reasoningtokencount','reasoning_token_count','reasoningtokens','reasoning_tokens',
        'thinkingtokencount','thinking_token_count','thinkingtokens','thinking_tokens'
    ]);
    for (const [key, value] of Object.entries(obj)) {
        const k = String(key).replace(/[^a-z0-9_]/gi, '').toLowerCase();
        if (exactKeys.has(k) || ((/thought|reasoning|thinking/.test(k)) && /token/.test(k))) {
            const n = numericTokenValue(value);
            if (n !== null && n >= 0 && n <= 500000) return { value: n, source: `message.${key}` };
        }
    }
    for (const value of Object.values(obj)) {
        if (value && typeof value === 'object') {
            const found = findThinkingTokensInObject(value, depth + 1, seen);
            if (found) return found;
        }
    }
    return null;
}

function latestAssistantMessage() {
    try {
        const ctx = SillyTavern.getContext();
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
        for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (msg && !msg.is_user && !msg.is_system) return { msg, id: i };
        }
        for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (msg && !msg.is_user) return { msg, id: i };
        }
    } catch { /* no-op */ }
    return { msg: null, id: null };
}

function readReportedThinkingTokens() {
    const { msg, id } = latestAssistantMessage();
    const isUnchangedBaseline = runtime.active
        && id !== null
        && id === runtime.baselineAssistantId
        && String(msg?.mes || '') === runtime.baselineAssistantMes;
    if (isUnchangedBaseline) return runtime.reportedThinkingTokens;
    if (msg) {
        const structured = findThinkingTokensInObject(msg);
        if (structured) {
            runtime.reportedThinkingTokens = structured.value;
            runtime.reportedTokenSource = structured.source;
            return structured.value;
        }
    }

    // Some mobile themes/extensions render a generation token badge such as "5091T"
    // without persisting it into chat.extra. Read only the message chrome, never正文/reasoning.
    let mes = null;
    if (id !== null) mes = document.querySelector(`#chat .mes[mesid="${id}"]`);
    if (!mes) {
        const candidates = [...document.querySelectorAll('#chat .mes')].filter(el => el.getAttribute('is_user') !== 'true');
        mes = candidates[candidates.length - 1] || null;
    }
    if (!mes) return runtime.reportedThinkingTokens;

    const clone = mes.cloneNode(true);
    clone.querySelectorAll('.mes_text,.mes_reasoning,.mes_reasoning_details,textarea,pre,code,#yrw-float').forEach(el => el.remove());
    const chromeText = String(clone.textContent || '').replace(/\s+/g, ' ');
    const hits = [...chromeText.matchAll(/(?:^|[^\w])([0-9]{2,7}(?:,[0-9]{3})*)\s*T(?![\w])/gi)]
        .map(m => Number(m[1].replace(/,/g, '')))
        .filter(n => Number.isFinite(n) && n >= 20 && n <= 500000);
    if (hits.length) {
        const value = Math.max(...hits);
        runtime.reportedThinkingTokens = value;
        runtime.reportedTokenSource = 'message-card T';
        return value;
    }
    return runtime.reportedThinkingTokens;
}

function readSavedReasoningDuration() {
    const { msg } = latestAssistantMessage();
    const n = Number(msg?.extra?.reasoning_duration);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function isOtherNativePopupOpen() {
    const own = watchdogPopup?.dlg || null;
    return [...document.querySelectorAll('dialog.popup,.popup.poly_dialog')].some(dlg => {
        if (dlg === own || !dlg.isConnected) return false;
        if (dlg instanceof HTMLDialogElement) return !!dlg.open;
        return dlg.hasAttribute('open') || getComputedStyle(dlg).display !== 'none';
    });
}

function syncFloatOcclusion() {
    const el = floatEl?.isConnected ? floatEl : document.getElementById('yrw-float');
    if (!el) return;
    el.classList.toggle('yrw-occluded', isOtherNativePopupOpen());
}

function emptyAnalysis() {
    return {
        score: 0,
        level: 'normal',
        repeatRatio: 0,
        novelty: 1,
        headingLoop: 0,
        reasoningChars: 0,
        approxTokens: 0,
        elapsedMs: 0,
        statusText: '等待生成',
        note: '尚未开始监控。',
    };
}

function settings() {
    if (!extension_settings[MODULE]) extension_settings[MODULE] = structuredClone(defaults);
    const s = extension_settings[MODULE];
    for (const [key, value] of Object.entries(defaults)) {
        if (s[key] === undefined) s[key] = structuredClone(value);
    }
    if (!Array.isArray(s.history)) s.history = [];
    return s;
}

function clamp(n, min, max) {
    return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
}

function formatK(n) {
    const value = Number(n) || 0;
    if (value < 1000) return String(value);
    return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}k`;
}

function formatTime(ms) {
    const sec = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

function approxTokens(text) {
    if (!text) return 0;
    const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
    const other = Math.max(0, text.length - cjk);
    return Math.round(cjk / 1.25 + other / 4.05);
}

function basicWords(text) {
    const lower = String(text || '').toLowerCase();
    const en = lower.match(/[a-z][a-z'-]{2,}/g) || [];
    const cjkChunks = lower.match(/[\u3400-\u9fff]{2,}/g) || [];
    const cjk = [];
    for (const chunk of cjkChunks) {
        for (let i = 0; i < chunk.length - 1; i++) cjk.push(chunk.slice(i, i + 2));
    }
    return [...en, ...cjk];
}

function contentWords(text, { forHeading = false } = {}) {
    return basicWords(text)
        .map(w => TOPIC_CANON.get(w) || w)
        .filter(w => !STOP_WORDS.has(w))
        .filter(w => !forHeading || !META_WORDS.has(w));
}

function shingleSet(words, n = 5) {
    const set = new Set();
    for (let i = 0; i <= words.length - n; i++) {
        set.add(words.slice(i, i + n).join(' '));
    }
    return set;
}

function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let common = 0;
    for (const x of a) if (b.has(x)) common++;
    return common / (a.size + b.size - common);
}

function headingLoopScore(text) {
    const lines = String(text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const headings = [];
    for (const line of lines) {
        if (line.length < 4 || line.length > 96) continue;
        const words = line.match(/[A-Za-z][A-Za-z'-]*/g) || [];
        if (words.length < 2 || words.length > 10) continue;
        const titleLike = words.filter(w => /^[A-Z]/.test(w)).length / words.length;
        const hasSentencePunct = /[.!?]$/.test(line);
        if (titleLike < 0.55 || hasSentencePunct) continue;
        const sigWords = contentWords(line, { forHeading: true });
        if (!sigWords.length) continue;
        headings.push(new Set(sigWords));
    }

    const recent = headings.slice(-20);
    if (recent.length < 5) return 0;
    let looped = 0;
    for (let i = 1; i < recent.length; i++) {
        let best = 0;
        for (let j = 0; j < i; j++) best = Math.max(best, jaccard(recent[i], recent[j]));
        if (best >= 0.5) looped++;
    }
    return looped / (recent.length - 1);
}

function thresholds() {
    const mode = settings().sensitivity;
    if (mode === 'sensitive') return { attention: 38, suspicious: 55, loop: 70 };
    if (mode === 'conservative') return { attention: 52, suspicious: 68, loop: 82 };
    return { attention: 45, suspicious: 60, loop: 75 };
}

function classify(score) {
    const t = thresholds();
    if (score >= t.loop) return 'loop';
    if (score >= t.suspicious) return 'suspicious';
    if (score >= t.attention) return 'attention';
    return 'normal';
}

function analyzeReasoning(text) {
    const raw = String(text || '');
    const chars = raw.length;
    const tokens = approxTokens(raw);
    const reasoningStart = runtime.reasoningStartedAt || 0;
    const reasoningEnd = runtime.reasoningDoneAt || (runtime.active ? Date.now() : runtime.lastReasoningChangedAt || Date.now());
    const elapsedMs = reasoningStart ? Math.max(0, reasoningEnd - reasoningStart) : 0;

    if (chars < 900) {
        return {
            score: 0,
            level: 'normal',
            repeatRatio: 0,
            novelty: 1,
            headingLoop: 0,
            reasoningChars: chars,
            approxTokens: tokens,
            elapsedMs,
            statusText: runtime.active ? '正常思考中' : '已完成',
            note: chars ? '样本还短，暂不判定回环。' : '尚未捕获到 reasoning。',
        };
    }

    const words = contentWords(raw);
    const recentCount = clamp(Math.floor(words.length * 0.28), 110, 260);
    const recent = words.slice(-recentCount);
    const previous = words.slice(0, Math.max(0, words.length - recentCount - 24));

    const prevShingles = shingleSet(previous, 5);
    const recentShingles = [];
    for (let i = 0; i <= recent.length - 5; i++) recentShingles.push(recent.slice(i, i + 5).join(' '));
    const repeatRatio = recentShingles.length
        ? recentShingles.filter(s => prevShingles.has(s)).length / recentShingles.length
        : 0;

    const prevUnique = new Set(previous);
    const recentUnique = new Set(recent);
    let newUnique = 0;
    for (const w of recentUnique) if (!prevUnique.has(w)) newUnique++;
    const novelty = recentUnique.size ? newUnique / recentUnique.size : 1;

    const headingLoop = headingLoopScore(raw);
    const lowNovelty = clamp((0.33 - novelty) / 0.33, 0, 1);
    const score = Math.round(clamp(repeatRatio * 56 + headingLoop * 29 + lowNovelty * 15, 0, 100));
    const level = classify(score);

    let statusText = '正常思考中';
    let note = '当前没有明显的重复回环。';
    if (level === 'attention') {
        statusText = '开始啰嗦';
        note = '信息增量正在下降，但还不足以判定复读。';
    } else if (level === 'suspicious') {
        statusText = '疑似复读';
        note = '近期内容与前文高度重合，建议观察是否继续爬升。';
    } else if (level === 'loop') {
        statusText = '明显回环';
        note = 'reasoning 正在反复解决相近问题，已经接近“换标题继续念”的模式。';
    } else if (!runtime.active) {
        statusText = '已完成';
    }

    return { score, level, repeatRatio, novelty, headingLoop, reasoningChars: chars, approxTokens: tokens, elapsedMs, statusText, note };
}

function findCurrentReasoning() {
    try {
        const ctx = SillyTavern.getContext();
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
        for (let i = chat.length - 1; i >= Math.max(0, chat.length - 4); i--) {
            const msg = chat[i];
            if (!msg || msg.is_user) continue;
            const reasoning = msg?.extra?.reasoning;
            if (typeof reasoning === 'string' && reasoning.length) {
                runtime.latestMessageId = i;
                return reasoning;
            }
        }
    } catch (error) {
        console.debug('[YRW] chat reasoning read failed:', error);
    }

    const blocks = [...document.querySelectorAll('#chat .mes .mes_reasoning')];
    for (let i = blocks.length - 1; i >= 0; i--) {
        const text = blocks[i]?.textContent?.trim();
        if (text) return text;
    }
    return '';
}

function estimateBodyChars() {
    let raw = '';
    try {
        const ctx = SillyTavern.getContext();
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
        for (let i = chat.length - 1; i >= Math.max(0, chat.length - 4); i--) {
            const msg = chat[i];
            if (msg && !msg.is_user && typeof msg.mes === 'string') {
                raw = msg.mes;
                break;
            }
        }
    } catch { /* DOM fallback below */ }

    if (!raw) {
        const messages = document.querySelectorAll('#chat .mes:not([is_user="true"]) .mes_text');
        raw = messages.length ? messages[messages.length - 1].textContent || '' : '';
    }

    const contentMatch = raw.match(/<content[^>]*>([\s\S]*?)<\/content>/i);
    if (contentMatch) raw = contentMatch[1];
    else raw = raw.replace(/<details[\s\S]*?<\/details>/gi, ' ');

    raw = raw.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
    return raw.replace(/\s/g, '').length;
}

function statusLabel(level) {
    return ({ normal: '正常', attention: '注意', suspicious: '疑似回环', loop: '明显回环' })[level] || '正常';
}

function maybeToast(a) {
    const s = settings();
    if (!s.toastEnabled || typeof toastr === 'undefined') return;
    const now = Date.now();
    if (now - runtime.lastToastAt < 6500) return;

    const rank = { normal: 0, attention: 1, suspicious: 2, loop: 3 };
    if (rank[a.level] <= rank[runtime.lastAlertLevel]) return;

    if (a.level === 'suspicious') {
        toastr.warning(`回环指数 ${a.score}｜近期 reasoning 重复度明显上升`, '🧠 Yuyu Watchdog');
        runtime.lastToastAt = now;
    } else if (a.level === 'loop') {
        toastr.error(`回环指数 ${a.score}｜哈基米疑似开始反复念同一件事`, '🧠 Yuyu Watchdog');
        runtime.lastToastAt = now;
    }
    runtime.lastAlertLevel = a.level;
}

function pushSample(a) {
    const last = runtime.samples[runtime.samples.length - 1];
    if (last && a.reasoningChars - last.chars < 120 && Date.now() - last.at < 1200) return;
    runtime.samples.push({ at: Date.now(), score: a.score, chars: a.reasoningChars });
    if (runtime.samples.length > MAX_SAMPLES) runtime.samples.shift();
}

function poll() {
    if (!settings().enabled) return;
    const reasoning = findCurrentReasoning();
    readReportedThinkingTokens();
    syncFloatOcclusion();
    if (!reasoning || reasoning.length === runtime.lastReasoningChars) {
        if (runtime.active) {
            if (runtime.reasoningStartedAt) {
                const end = runtime.reasoningDoneAt || Date.now();
                runtime.analysis.elapsedMs = Math.max(0, end - runtime.reasoningStartedAt);
            } else {
                runtime.analysis.elapsedMs = 0;
            }
            updateUI();
        }
        return;
    }

    const now = Date.now();
    if (!runtime.reasoningStartedAt) runtime.reasoningStartedAt = now;
    runtime.lastReasoningChangedAt = now;
    runtime.lastReasoning = reasoning;
    runtime.lastReasoningChars = reasoning.length;
    runtime.analysis = analyzeReasoning(reasoning);
    pushSample(runtime.analysis);
    maybeToast(runtime.analysis);
    updateUI();
}

function startMonitoring() {
    if (!settings().enabled) return;
    clearInterval(runtime.timer);
    runtime.active = true;
    runtime.finalizing = false;
    runtime.guideInjectedThisRun = false;
    runtime.startedAt = Date.now();
    runtime.reasoningStartedAt = 0;
    runtime.reasoningDoneAt = 0;
    runtime.lastReasoningChangedAt = 0;
    runtime.lastReasoning = '';
    runtime.lastReasoningChars = 0;
    runtime.latestBodyChars = 0;
    runtime.latestMessageId = null;
    runtime.reportedThinkingTokens = null;
    runtime.reportedTokenSource = '';
    const baseline = latestAssistantMessage();
    runtime.baselineAssistantId = baseline.id;
    runtime.baselineAssistantMes = String(baseline.msg?.mes || '');
    runtime.analysis = emptyAnalysis();
    runtime.analysis.statusText = '等待 reasoning';
    runtime.analysis.note = '生成已开始，正在等待模型思考流。';
    runtime.samples = [];
    runtime.lastAlertLevel = 'normal';
    runtime.timer = setInterval(poll, POLL_MS);
    poll();
    updateUI();
}

function finishMonitoring(reasoningFromEvent = '') {
    if (runtime.finalizing || !runtime.active) return;
    runtime.finalizing = true;
    if (reasoningFromEvent && reasoningFromEvent.length >= runtime.lastReasoningChars) {
        runtime.lastReasoning = reasoningFromEvent;
        runtime.lastReasoningChars = reasoningFromEvent.length;
        runtime.analysis = analyzeReasoning(reasoningFromEvent);
        pushSample(runtime.analysis);
    } else {
        poll();
    }

    setTimeout(() => {
        runtime.active = false;
        clearInterval(runtime.timer);
        runtime.timer = null;
        if (!runtime.reasoningDoneAt && runtime.reasoningStartedAt) {
            runtime.reasoningDoneAt = runtime.lastReasoningChangedAt || Date.now();
        }
        const savedReasoningDuration = readSavedReasoningDuration();
        runtime.analysis.elapsedMs = savedReasoningDuration ?? (runtime.reasoningStartedAt
            ? Math.max(0, (runtime.reasoningDoneAt || Date.now()) - runtime.reasoningStartedAt)
            : 0);
        runtime.analysis.statusText = runtime.analysis.reasoningChars ? `已完成 · ${statusLabel(runtime.analysis.level)}` : '已完成';
        runtime.latestBodyChars = estimateBodyChars();
        readReportedThinkingTokens();
        saveRunSummary();
        updateUI();
        runtime.finalizing = false;
    }, 280);
}

function saveRunSummary() {
    const s = settings();
    if (!runtime.analysis.reasoningChars && !runtime.latestBodyChars) return;
    s.history.unshift({
        at: Date.now(),
        reasoningChars: runtime.analysis.reasoningChars,
        approxTokens: runtime.analysis.approxTokens,
        reportedThinkingTokens: runtime.reportedThinkingTokens,
        reportedTokenSource: runtime.reportedTokenSource,
        score: runtime.analysis.score,
        level: runtime.analysis.level,
        durationMs: runtime.analysis.elapsedMs,
        bodyChars: runtime.latestBodyChars,
        thinkingGuide: runtime.guideInjectedThisRun ? String(s.thinkingGuideMode || 'fixed') : 'off',
    });
    s.history = s.history.slice(0, MAX_HISTORY);
    saveSettingsDebounced();
}

function q(id) {
    return popupRoot?.querySelector(`#${id}`) || null;
}

function buildPopupContent() {
    const root = document.createElement('div');
    root.id = 'yrw-popup-root';
    root.className = 'yrw-popup-root';
    root.dataset.level = runtime.analysis.level || 'normal';
    root.innerHTML = `
      <header class="yrw-head">
        <div class="yrw-brand">
          <div class="yrw-brand-mark"><i class="fa-solid fa-brain"></i></div>
          <div class="yrw-brand-copy">
            <div class="yrw-title">思维监工</div>
            <div class="yrw-subtitle">Reasoning Watchdog · v0.3.1</div>
          </div>
        </div>
        <div class="yrw-head-actions">
          <div class="yrw-live-pill"><span></span><b id="yrw-live-label">待机</b></div>
          <button id="yrw-close-panel" class="yrw-close-btn" type="button" aria-label="关闭思维监工" title="关闭">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
      </header>

      <section class="yrw-overview-card">
        <div class="yrw-overview-copy">
          <div class="yrw-kicker">当前状态</div>
          <div id="yrw-badge" class="yrw-state-title">待机</div>
          <div id="yrw-alert-text" class="yrw-state-note">尚未开始监控。</div>
          <div class="yrw-usage-line">
            <span class="yrw-usage-icon"><i class="fa-solid fa-bars-staggered"></i></span>
            <strong id="yrw-token-main">未捕获</strong><span id="yrw-token-kind">卡片 T</span>
            <i class="yrw-usage-sep"></i><b id="yrw-visible-token">可见≈0 tok</b>
            <i class="yrw-usage-sep"></i><b id="yrw-reasoning-main">0 字符</b>
          </div>
        </div>
        <div class="yrw-score-card">
          <div id="yrw-gauge" class="yrw-gauge" style="--score:0">
            <div class="yrw-gauge-inner">
              <strong id="yrw-score">0</strong>
              <span>回环</span>
            </div>
          </div>
          <span class="yrw-score-caption">回环指数 / 100</span>
        </div>
      </section>

      <section class="yrw-metrics-card">
        <div class="yrw-metric">
          <span class="yrw-metric-icon"><i class="fa-regular fa-clock"></i></span>
          <div class="yrw-metric-copy"><span>思考耗时</span><b id="yrw-time">0s</b></div>
        </div>
        <div class="yrw-metric">
          <span class="yrw-metric-icon yrw-spinner-icon"><i class="fa-solid fa-circle-notch"></i></span>
          <div class="yrw-metric-copy"><span>正文估算</span><b id="yrw-body">—</b></div>
        </div>
        <div class="yrw-metric yrw-metric-bar">
          <span class="yrw-metric-icon"><i class="fa-solid fa-braille"></i></span>
          <div class="yrw-metric-copy">
            <div class="yrw-metric-row"><span>5-gram 重复</span><b id="yrw-repeat">0%</b></div>
            <div class="yrw-meter"><i id="yrw-repeat-bar"></i></div>
          </div>
        </div>
        <div class="yrw-metric yrw-metric-bar">
          <span class="yrw-metric-icon"><i class="fa-regular fa-lemon"></i></span>
          <div class="yrw-metric-copy">
            <div class="yrw-metric-row"><span>信息新颖度</span><b id="yrw-novelty">100%</b></div>
            <div class="yrw-meter yrw-meter-good"><i id="yrw-novelty-bar"></i></div>
          </div>
        </div>
      </section>

      <section class="yrw-trend-card">
        <div class="yrw-trend-top">
          <div class="yrw-trend-title">
            <span class="yrw-trend-icon"><i class="fa-solid fa-arrow-trend-up"></i></span>
            <div><b>本轮趋势</b><span>回环指数</span></div>
          </div>
          <div class="yrw-trend-meta"><span id="yrw-heading-loop">标题回环 0%</span><i class="fa-solid fa-chevron-right"></i></div>
        </div>
        <svg id="yrw-sparkline" viewBox="0 0 300 42" preserveAspectRatio="none" aria-label="回环指数趋势图">
          <line class="yrw-axis" x1="0" y1="36" x2="300" y2="36"></line>
          <polyline class="yrw-line" points="0,36 300,36"></polyline>
        </svg>
      </section>

      <section class="yrw-controls">
        <div class="yrw-actions">
          <button id="yrw-toggle-float" type="button" class="yrw-action-btn yrw-action-primary"><i class="fa-solid fa-location-dot"></i><span>开启悬浮</span></button>
          <button id="yrw-reset-current" type="button" class="yrw-action-btn"><i class="fa-solid fa-rotate-left"></i><span>清空本轮</span></button>
        </div>
        <div class="yrw-popup-opacity">
          <div><span>悬浮透明度</span><b id="yrw-popup-opacity-value">35%</b></div>
          <input id="yrw-popup-opacity" type="range" min="15" max="100" step="5" value="35" aria-label="悬浮透明度" />
        </div>
      </section>`;

    root.querySelector('#yrw-close-panel')?.addEventListener('click', () => void closePanel());
    root.querySelector('#yrw-toggle-float')?.addEventListener('click', () => {
        const s = settings();
        s.floatEnabled = !s.floatEnabled;
        saveSettingsDebounced();
        syncSettingsUI();
        updateUI();
    });
    const popupOpacity = root.querySelector('#yrw-popup-opacity');
    const popupOpacityValue = root.querySelector('#yrw-popup-opacity-value');
    if (popupOpacity) {
        const s = settings();
        popupOpacity.value = String(clamp(Number(s.floatOpacity ?? 35), 15, 100));
        if (popupOpacityValue) popupOpacityValue.textContent = `${popupOpacity.value}%`;
        popupOpacity.addEventListener('input', () => {
            const value = clamp(Number(popupOpacity.value || 35), 15, 100);
            s.floatOpacity = value;
            if (popupOpacityValue) popupOpacityValue.textContent = `${value}%`;
            $('#yrw_float_opacity').val(value);
            $('#yrw_float_opacity_value').text(`${value}%`);
            applyFloatOpacity(ensureFloat());
            saveSettingsDebounced();
        });
    }

    root.querySelector('#yrw-reset-current')?.addEventListener('click', () => {
        runtime.samples = [];
        if (!runtime.active) {
            runtime.analysis = emptyAnalysis();
            runtime.latestBodyChars = 0;
            runtime.lastReasoning = '';
            runtime.lastReasoningChars = 0;
        }
        updateUI();
    });
    return root;
}

async function closePanel() {
    const popup = watchdogPopup;
    if (!popup?.dlg?.isConnected) return;
    try {
        await popup.complete(POPUP_RESULT.CANCELLED);
    } catch (error) {
        console.debug('[YRW] Popup complete failed, using dialog close fallback:', error);
        try { popup.dlg.close?.(); } catch { /* noop */ }
        if (watchdogPopup === popup) watchdogPopup = null;
        popupRoot = null;
        updateUI();
    }
}

function openPanel(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();

    if (watchdogPopup?.dlg?.isConnected) {
        watchdogPopup.dlg.focus?.();
        return;
    }

    popupRoot = buildPopupContent();
    const popup = new Popup(popupRoot, POPUP_TYPE.DISPLAY, '', {
        large: true,
        leftAlign: true,
        allowVerticalScrolling: true,
        animation: 'fast',
        onClose: () => {
            if (watchdogPopup === popup) watchdogPopup = null;
            popupRoot = null;
            updateUI();
        },
    });
    popup.dlg.classList.add('yrw-watchdog-dialog');
    // 酒馆主题会把原生 DISPLAY 关闭按钮画成奇怪的角标；本插件使用自己的 X。
    if (popup.closeButton) popup.closeButton.style.setProperty('display', 'none', 'important');
    watchdogPopup = popup;
    updateUI();

    void popup.show().catch(error => {
        console.warn('[YRW] Native popup failed:', error);
        if (typeof toastr !== 'undefined') toastr.error('监控面板打开失败，请查看控制台。', 'Yuyu Watchdog');
    });
}

function togglePanel(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (watchdogPopup?.dlg?.isConnected) void closePanel();
    else openPanel(event);
}

function bindToolbarButton(button) {
    if (!button || button.dataset.yrwBound === '1') return;
    button.dataset.yrwBound = '1';
    const toggle = button.querySelector('.drawer-toggle') || button;
    toggle.addEventListener('click', togglePanel);
}

function applyFloatOpacity(el, interactive = false) {
    if (!el) return;
    const pct = clamp(Number(settings().floatOpacity ?? 35), 15, 100);
    el.style.opacity = interactive ? '1' : String(pct / 100);
    el.style.setProperty('--yrw-float-opacity', String(pct / 100));
}

function ensureFloat() {
    if (floatEl?.isConnected) return floatEl;
    const existing = document.getElementById('yrw-float');
    if (existing) {
        floatEl = existing;
        applyFloatOpacity(floatEl);
        return floatEl;
    }
    const el = document.createElement('button');
    el.id = 'yrw-float';
    el.type = 'button';
    el.setAttribute('aria-label', '打开 Yuyu Reasoning Watchdog');
    el.innerHTML = '<span class="yrw-float-brain">🧠</span><span class="yrw-float-text">待机</span><span class="yrw-float-dot"></span>';
    document.body.appendChild(el);
    applyFloatOpacity(el);
    setupFloatingDrag(el);
    el.addEventListener('click', (event) => {
        if (el.dataset.dragged === '1') {
            el.dataset.dragged = '0';
            return;
        }
        togglePanel(event);
    });
    floatEl = el;
    return el;
}

function setupFloatingDrag(el) {
    let startX = 0, startY = 0, startLeft = 0, startTop = 0, moved = false;
    el.addEventListener('pointerdown', (e) => {
        moved = false;
        el.setPointerCapture?.(e.pointerId);
        const rect = el.getBoundingClientRect();
        startX = e.clientX; startY = e.clientY; startLeft = rect.left; startTop = rect.top;
        el.classList.add('is-dragging');
        applyFloatOpacity(el, true);
    });
    el.addEventListener('pointermove', (e) => {
        if (!el.classList.contains('is-dragging')) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (Math.hypot(dx, dy) > 5) moved = true;
        const x = clamp(startLeft + dx, 4, window.innerWidth - el.offsetWidth - 4);
        const y = clamp(startTop + dy, 54, window.innerHeight - el.offsetHeight - 84);
        el.style.left = `${x}px`;
        el.style.right = 'auto';
        el.style.top = `${y}px`;
    });
    const end = (e) => {
        if (!el.classList.contains('is-dragging')) return;
        el.classList.remove('is-dragging');
        el.releasePointerCapture?.(e.pointerId);
        el.dataset.dragged = moved ? '1' : '0';
        if (moved) {
            const rect = el.getBoundingClientRect();
            settings().floatTopPct = clamp(rect.top / Math.max(1, window.innerHeight) * 100, 8, 82);
            saveSettingsDebounced();
        }
        setTimeout(() => applyFloatOpacity(el), 120);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
}

function buildToolbarEntry() {
    const btn = document.createElement('div');
    btn.id = 'yrw-toolbar-entry';
    btn.className = 'drawer';
    btn.dataset.level = runtime.analysis.level || 'normal';
    btn.innerHTML = `
      <div class="drawer-toggle">
        <div class="drawer-icon fa-solid fa-brain fa-fw closedIcon" title="Yuyu Reasoning Watchdog">
          <span class="yrw-toolbar-dot" aria-hidden="true"></span>
        </div>
      </div>`;
    bindToolbarButton(btn);
    return btn;
}

function tryInjectToolbarEntry() {
    const s = settings();
    const existing = document.getElementById('yrw-toolbar-entry');
    if (!s.toolbarEnabled) {
        existing?.remove();
        return true;
    }
    if (existing?.isConnected) {
        bindToolbarButton(existing);
        return true;
    }

    const holder = document.getElementById('top-settings-holder');
    if (!holder) return false;

    const btn = buildToolbarEntry();
    const persona = document.getElementById('persona-management-button');
    if (persona) persona.before(btn);
    else holder.appendChild(btn);
    return true;
}

function ensureToolbarEntry() {
    if (toolbarPollTimer) {
        clearInterval(toolbarPollTimer);
        toolbarPollTimer = null;
    }
    if (tryInjectToolbarEntry()) return true;

    let attempts = 0;
    toolbarPollTimer = setInterval(() => {
        if (tryInjectToolbarEntry() || ++attempts > 40) {
            clearInterval(toolbarPollTimer);
            toolbarPollTimer = null;
        }
    }, 500);
    return false;
}

function drawSparkline() {
    const svg = q('yrw-sparkline');
    const line = svg?.querySelector('.yrw-line');
    if (!line) return;
    const data = runtime.samples.length ? runtime.samples : [{ score: 0 }, { score: 0 }];
    const width = 300, height = 48;
    const points = data.map((d, i) => {
        const x = data.length <= 1 ? 0 : (i / (data.length - 1)) * width;
        const y = height - clamp(d.score, 0, 100) / 100 * 43;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    line.setAttribute('points', points || '0,48 300,48');
}

function updateUI() {
    ensureToolbarEntry();
    const s = settings();
    const a = runtime.analysis || emptyAnalysis();
    const level = a.level || 'normal';

    const toolbar = document.getElementById('yrw-toolbar-entry');
    if (toolbar) {
        toolbar.dataset.level = level;
        const panelOpen = !!watchdogPopup?.dlg?.isConnected;
        toolbar.classList.toggle('yrw-panel-open', panelOpen);
        toolbar.title = panelOpen
            ? '关闭 Yuyu Reasoning Watchdog'
            : `打开 Yuyu Watchdog · ${a.statusText || statusLabel(level)} · 回环 ${a.score || 0}`;
    }

    const float = ensureFloat();
    if (float) {
        float.dataset.level = level;
        float.classList.toggle('is-visible', !!s.floatEnabled);
        if (!float.classList.contains('is-dragging')) applyFloatOpacity(float);
        if (!float.classList.contains('is-dragging') && !float.style.left) float.style.top = `${clamp(s.floatTopPct, 8, 82)}%`;
        syncFloatOcclusion();
        const tokenBadge = runtime.reportedThinkingTokens !== null
            ? `${formatK(runtime.reportedThinkingTokens)}T`
            : `≈${formatK(a.approxTokens)}t`;
        const label = runtime.active
            ? `${tokenBadge} · ${a.score}`
            : a.reasoningChars ? `${tokenBadge} · 完成` : '待机';
        const text = float.querySelector('.yrw-float-text');
        if (text) text.textContent = label;
    }

    if (!popupRoot?.isConnected) return;
    popupRoot.dataset.level = level;
    const setText = (id, value) => { const el = q(id); if (el) el.textContent = value; };
    setText('yrw-live-label', runtime.active ? '监控中' : '待机');
    setText('yrw-badge', a.statusText || statusLabel(level));
    setText('yrw-reasoning-main', `${formatK(a.reasoningChars || 0)} 字符`);
    const reported = readReportedThinkingTokens();
    setText('yrw-token-main', reported !== null ? `${formatK(reported)}T` : '未捕获');
    setText('yrw-token-kind', reported !== null ? '卡片报告' : '卡片 T');
    setText('yrw-visible-token', `可见≈${formatK(a.approxTokens || 0)} tok`);
    const tokenMain = q('yrw-token-main');
    if (tokenMain) tokenMain.title = reported !== null
        ? `来源：${runtime.reportedTokenSource || '消息卡片'}。这是宿主/主题显示的 T 值，不冒充 Gemini usageMetadata。`
        : '尚未从消息对象或消息卡片捕获 T 值。';
    setText('yrw-score', String(Math.round(a.score || 0)));
    setText('yrw-time', formatTime(a.elapsedMs || 0));
    setText('yrw-repeat', `${Math.round((a.repeatRatio || 0) * 100)}%`);
    setText('yrw-novelty', `${Math.round((a.novelty ?? 1) * 100)}%`);
    setText('yrw-body', runtime.latestBodyChars ? `${formatK(runtime.latestBodyChars)} 字符` : runtime.active ? '生成中' : '—');
    setText('yrw-heading-loop', `标题回环 ${Math.round((a.headingLoop || 0) * 100)}%`);
    setText('yrw-alert-text', a.note || '尚未开始监控。');

    const alert = q('yrw-alert-text');
    alert?.classList.toggle('yrw-alert-muted', level === 'normal');
    const gauge = q('yrw-gauge');
    if (gauge) gauge.style.setProperty('--score', String(clamp(Math.round(a.score || 0), 0, 100)));
    const repeatBar = q('yrw-repeat-bar');
    if (repeatBar) repeatBar.style.width = `${clamp((a.repeatRatio || 0) * 100, 0, 100)}%`;
    const noveltyBar = q('yrw-novelty-bar');
    if (noveltyBar) noveltyBar.style.width = `${clamp((a.novelty ?? 1) * 100, 0, 100)}%`;
    const popupOpacity = q('yrw-popup-opacity');
    if (popupOpacity && document.activeElement !== popupOpacity) popupOpacity.value = String(clamp(Number(s.floatOpacity ?? 35), 15, 100));
    setText('yrw-popup-opacity-value', `${clamp(Number(s.floatOpacity ?? 35), 15, 100)}%`);
    const floatBtn = q('yrw-toggle-float');
    if (floatBtn) {
        const label = floatBtn.querySelector('span');
        if (label) label.textContent = s.floatEnabled ? '关闭悬浮' : '开启悬浮';
    }
    drawSparkline();
}

function syncSettingsUI() {
    const s = settings();
    $('#yrw_enabled').prop('checked', !!s.enabled);
    $('#yrw_toolbar_enabled').prop('checked', !!s.toolbarEnabled);
    $('#yrw_float_enabled').prop('checked', !!s.floatEnabled);
    $('#yrw_float_opacity').val(clamp(Number(s.floatOpacity ?? 35), 15, 100));
    $('#yrw_float_opacity_value').text(`${clamp(Number(s.floatOpacity ?? 35), 15, 100)}%`);
    $('#yrw_toast_enabled').prop('checked', !!s.toastEnabled);
    $('#yrw_sensitivity').val(s.sensitivity);
    updateGuideSettingsUI();
}

async function mountSettings() {
    if (document.getElementById('yrw_settings')) return;
    try {
        // Match mature third-party extensions (e.g. BaiBai Tools): mount an
        // extension_container inside #extensions_settings2, then let
        // SillyTavern's native inline-drawer own the fold/unfold lifecycle.
        // Do not combine <details> with inline-drawer classes: both layers
        // would try to control visibility and can fight on mobile.
        const root = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
        if (!root.length) throw new Error('SillyTavern extension settings root not found');

        let container = $('#yrw_settings_container');
        if (!container.length) {
            container = $('<div id="yrw_settings_container" class="extension_container"></div>');
            root.append(container);
        }

        const html = await renderExtensionTemplateAsync(`third-party/${EXTENSION_FOLDER}`, 'settings');
        container.empty().append(html);
    } catch (error) {
        console.warn('[YRW] Failed to mount settings UI:', error);
        return;
    }

    syncSettingsUI();
    const s = settings();
    $('#yrw_enabled').on('change', function () {
        s.enabled = !!$(this).prop('checked');
        saveSettingsDebounced();
        if (!s.enabled) {
            clearInterval(runtime.timer); runtime.timer = null; runtime.active = false;
        }
        updateUI();
    });
    $('#yrw_toolbar_enabled').on('change', function () {
        s.toolbarEnabled = !!$(this).prop('checked'); saveSettingsDebounced(); updateUI();
    });
    $('#yrw_float_enabled').on('change', function () {
        s.floatEnabled = !!$(this).prop('checked'); saveSettingsDebounced(); updateUI();
    });
    $('#yrw_float_opacity').on('input change', function () {
        s.floatOpacity = clamp(Number($(this).val() || 35), 15, 100);
        $('#yrw_float_opacity_value').text(`${s.floatOpacity}%`);
        saveSettingsDebounced();
        applyFloatOpacity(ensureFloat());
    });
    $('#yrw_toast_enabled').on('change', function () {
        s.toastEnabled = !!$(this).prop('checked'); saveSettingsDebounced();
    });
    $('#yrw_sensitivity').on('change', function () {
        s.sensitivity = String($(this).val() || 'balanced'); saveSettingsDebounced();
        if (runtime.lastReasoning) runtime.analysis = analyzeReasoning(runtime.lastReasoning);
        updateUI();
    });
    $('#yrw_thinking_guide_enabled').on('change', function () {
        s.thinkingGuideEnabled = !!$(this).prop('checked');
        saveSettingsDebounced();
        updateGuideSettingsUI();
    });
    $('#yrw_thinking_guide_mode').on('change', function () {
        s.thinkingGuideMode = String($(this).val() || 'fixed');
        saveSettingsDebounced();
        updateGuideSettingsUI();
    });
    $('#yrw_custom_thinking_guide').on('input change', function () {
        s.customThinkingGuide = String($(this).val() || '').slice(0, GUIDE_MAX_CHARS);
        if ($(this).val() !== s.customThinkingGuide) $(this).val(s.customThinkingGuide);
        saveSettingsDebounced();
        $('#yrw_guide_preview').val(currentThinkingGuide());
    });
    $('#yrw_restore_fixed_guide').on('click', function () {
        s.customThinkingGuide = FIXED_THINKING_GUIDE;
        $('#yrw_custom_thinking_guide').val(s.customThinkingGuide);
        $('#yrw_guide_preview').val(currentThinkingGuide());
        saveSettingsDebounced();
    });
    $('#yrw_open_monitor').on('click', openPanel);
    $('#yrw_reset_history').on('click', () => {
        s.history = [];
        saveSettingsDebounced();
        if (typeof toastr !== 'undefined') toastr.success('已清空本地统计', 'Yuyu Watchdog');
    });
}

function bindEvents() {
    eventSource.makeLast(event_types.CHAT_COMPLETION_PROMPT_READY, injectThinkingGuide);
    eventSource.on(event_types.GENERATION_STARTED, startMonitoring);
    eventSource.on(event_types.GENERATION_ENDED, () => finishMonitoring());
    eventSource.on(event_types.GENERATION_STOPPED, () => finishMonitoring());
    eventSource.on(event_types.STREAM_REASONING_DONE, (reasoning, duration, messageId) => {
        if (typeof reasoning === 'string' && reasoning) {
            const now = Date.now();
            if (Number.isInteger(messageId)) runtime.latestMessageId = messageId;
            if (!runtime.reasoningStartedAt) runtime.reasoningStartedAt = runtime.lastReasoningChangedAt || now;
            runtime.lastReasoningChangedAt = now;
            runtime.reasoningDoneAt = Number.isFinite(Number(duration)) && Number(duration) > 0
                ? runtime.reasoningStartedAt + Number(duration)
                : now;
            runtime.lastReasoning = reasoning;
            runtime.lastReasoningChars = reasoning.length;
            runtime.analysis = analyzeReasoning(reasoning);
            if (Number.isFinite(Number(duration)) && Number(duration) > 0) runtime.analysis.elapsedMs = Number(duration);
            pushSample(runtime.analysis);
            readReportedThinkingTokens();
            updateUI();
        }
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        setTimeout(() => {
            runtime.latestBodyChars = estimateBodyChars();
            readReportedThinkingTokens();
            if (runtime.active && !runtime.finalizing) finishMonitoring();
            else updateUI();
        }, 420);
    });
}

jQuery(async () => {
    settings();
    await mountSettings();
    bindEvents();
    ensureToolbarEntry();
    updateUI();

    // Theme / mobile shells may rebuild the top bar. Reattach gently when needed.
    setInterval(() => {
        if (settings().toolbarEnabled && !document.getElementById('yrw-toolbar-entry')) ensureToolbarEntry();
    }, 2500);
    setInterval(syncFloatOcclusion, 650);

    console.info('[YRW] Yuyu Reasoning Watchdog v0.3.1 loaded (native Popup + native extension drawer + one-shot thinking guide experiment).');
});
