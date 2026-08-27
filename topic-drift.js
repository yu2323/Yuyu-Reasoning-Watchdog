const WINDOW_WORDS = 110;
const MIN_WINDOWS = 5;
const MAX_WINDOWS = 12;
const SEED_CHARS = 760;
const CARRY_CHARS = 900;

function clamp(n, min, max) {
    return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
}

function average(values) {
    const nums = values.filter(Number.isFinite);
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function cleanChatText(value) {
    return String(value || '')
        .replace(/<details[\s\S]*?<\/details>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function setCosine(a, b) {
    if (!a?.size || !b?.size) return 0;
    let common = 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const value of small) if (large.has(value)) common++;
    return common / Math.sqrt(a.size * b.size);
}

function wordsToSet(words) {
    return new Set((words || []).filter(Boolean));
}

function classify(score, collecting = false, anchorMissing = false) {
    if (anchorMissing) return { level: 'unknown', label: '锚点不足' };
    if (collecting) return { level: 'collecting', label: '建立中' };
    if (score >= 75) return { level: 'far', label: '明显跑远' };
    if (score >= 45) return { level: 'slight', label: '轻微偏离' };
    return { level: 'stable', label: '稳定' };
}

function captureTurnAnchor(getWords) {
    try {
        const ctx = SillyTavern.getContext();
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
        let userIndex = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i]?.is_user) {
                userIndex = i;
                break;
            }
        }
        if (userIndex < 0) return { words: new Set(), source: 'reasoning seed only' };

        const userText = cleanChatText(chat[userIndex]?.mes);
        const userWords = getWords(userText);
        let carryText = '';
        if (userText.length < 90 || userWords.length < 18) {
            for (let i = userIndex - 1; i >= 0; i--) {
                const msg = chat[i];
                if (!msg || msg.is_user || msg.is_system) continue;
                carryText = cleanChatText(msg.mes).slice(-CARRY_CHARS);
                break;
            }
        }

        const combined = `${carryText} ${userText}`.trim();
        const words = getWords(combined).slice(-280);
        return {
            words: wordsToSet(words),
            source: carryText ? 'USER + 上轮正文尾部' : 'USER',
        };
    } catch (error) {
        console.debug('[YRW drift] anchor capture failed:', error);
        return { words: new Set(), source: 'reasoning seed only' };
    }
}

export function createTopicDriftState() {
    return {
        score: 0,
        level: 'collecting',
        label: '建立中',
        note: '等待足够 reasoning 建立锚点轨迹。',
        affinity: 1,
        baselineAffinity: 1,
        directAffinity: 0,
        churn: 0,
        windowCount: 0,
        anchorSource: '',
        anchorWords: new Set(),
        seedWords: new Set(),
        seedLocked: false,
    };
}

export function startTopicDrift(getWords) {
    const state = createTopicDriftState();
    const anchor = captureTurnAnchor(getWords);
    state.anchorWords = anchor.words;
    state.anchorSource = anchor.source;
    return state;
}

function maybeLockSeed(raw, state, getWords) {
    if (state.seedLocked || raw.length < 480) return;
    const seedWords = getWords(raw.slice(0, SEED_CHARS)).slice(0, 220);
    if (seedWords.length < 24) return;
    state.seedWords = wordsToSet(seedWords);
    state.seedLocked = true;
}

function makeWindows(words) {
    if (!words.length) return [];
    const windows = [];
    for (let i = 0; i + WINDOW_WORDS <= words.length; i += WINDOW_WORDS) {
        windows.push(wordsToSet(words.slice(i, i + WINDOW_WORDS)));
    }
    if (words.length >= WINDOW_WORDS && words.length % WINDOW_WORDS > WINDOW_WORDS * 0.58) {
        windows.push(wordsToSet(words.slice(-WINDOW_WORDS)));
    }
    return windows.slice(-MAX_WINDOWS);
}

function windowAffinity(windowSet, state) {
    const direct = setCosine(windowSet, state.anchorWords);
    const seed = setCosine(windowSet, state.seedWords);
    return {
        affinity: Math.max(direct, seed * 0.88),
        direct,
    };
}

export function analyzeTopicDrift(text, state, getWords) {
    const raw = String(text || '');
    const next = state || createTopicDriftState();
    maybeLockSeed(raw, next, getWords);

    const words = getWords(raw);
    const windows = makeWindows(words);
    next.windowCount = windows.length;

    const anchorMissing = !next.anchorWords.size && !next.seedWords.size;
    if (anchorMissing) {
        Object.assign(next, {
            score: 0,
            ...classify(0, false, true),
            note: '当前拿不到足够的本轮 USER / reasoning 起点词，暂不判偏离。',
            affinity: 0,
            baselineAffinity: 0,
            directAffinity: 0,
            churn: 0,
        });
        return next;
    }

    if (windows.length < MIN_WINDOWS || !next.seedLocked) {
        const info = classify(0, true, false);
        Object.assign(next, {
            score: 0,
            ...info,
            note: `已锁定${next.anchorSource || '本轮'}锚点，样本不足，继续观察。`,
        });
        return next;
    }

    const scored = windows.map(windowSet => windowAffinity(windowSet, next));
    const affinities = scored.map(x => x.affinity);
    const directAffinities = scored.map(x => x.direct);
    const early = affinities.slice(0, Math.min(2, affinities.length));
    const recent = affinities.slice(-3);
    const recentDirect = directAffinities.slice(-3);

    const baseline = Math.max(0.01, average(early));
    const recentAffinity = average(recent);
    const directRecent = average(recentDirect);
    const relativeLoss = clamp((baseline - recentAffinity) / Math.max(0.12, baseline), 0, 1);
    const lowLine = Math.max(0.08, baseline * 0.28);
    const sustainedLow = recent.filter(value => value < lowLine).length / recent.length;
    const absoluteLow = clamp((0.12 - recentAffinity) / 0.12, 0, 1);

    const recentSets = windows.slice(-4);
    const adjacent = [];
    for (let i = 1; i < recentSets.length; i++) adjacent.push(setCosine(recentSets[i - 1], recentSets[i]));
    const churn = clamp(1 - average(adjacent), 0, 1);

    let score = Math.round(clamp(
        relativeLoss * 45
        + sustainedLow * 30
        + absoluteLow * 15
        + churn * relativeLoss * 10,
        0,
        100,
    ));

    // If recent reasoning still directly overlaps the USER/carry anchor, do not call it "far".
    // This guards legitimate multi-step reasoning that simply stopped repeating its opening wording.
    if (directRecent >= 0.15) score = Math.min(score, 44);

    const info = classify(score, false, false);
    let note = '近期主题仍与本轮锚点保持连续。';
    if (info.level === 'slight') {
        note = '近期主题与本轮起点的联系在变弱，先观察是否继续外扩。';
    } else if (info.level === 'far') {
        note = '连续多个窗口远离本轮锚点，并伴随主题换轨；疑似“从南极跑北极”。';
    }

    Object.assign(next, {
        score,
        ...info,
        note,
        affinity: recentAffinity,
        baselineAffinity: baseline,
        directAffinity: directRecent,
        churn,
    });
    return next;
}
