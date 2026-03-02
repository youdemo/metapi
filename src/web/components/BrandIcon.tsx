import React, { useState, useEffect } from 'react';
const ICON_CDN = 'https://registry.npmmirror.com/@lobehub/icons-static-png/latest/files/dark';
const ICON_CDN_LIGHT = 'https://registry.npmmirror.com/@lobehub/icons-static-png/latest/files/light';
export function useIconCdn() {
    const [isDark, setIsDark] = useState(() => document.documentElement.getAttribute('data-theme') === 'dark');
    useEffect(() => {
        const observer = new MutationObserver(() => {
            setIsDark(document.documentElement.getAttribute('data-theme') === 'dark');
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        return () => observer.disconnect();
    }, []);
    return isDark ? ICON_CDN : ICON_CDN_LIGHT;
}

export interface BrandInfo {
    name: string;
    icon: string;
    color: string;
}

const BRAND_MAP: Array<{ prefixes: string[]; brand: BrandInfo }> = [
    {
        prefixes: ['gpt', 'o1', 'o3', 'o4', 'chatgpt', 'dall-e', 'text-embedding', 'text-davinci', 'text-curie', 'text-babbage', 'text-ada', 'whisper', 'tts'],
        brand: { name: 'OpenAI', icon: 'openai', color: 'linear-gradient(135deg, #10a37f, #1a7f5a)' }
    },
    {
        prefixes: ['claude'],
        brand: { name: 'Anthropic', icon: 'claude.color', color: 'linear-gradient(135deg, #d4a574, #c4956a)' }
    },
    {
        prefixes: ['gemini', 'gemma'],
        brand: { name: 'Google', icon: 'gemini.color', color: 'linear-gradient(135deg, #4285f4, #34a853)' }
    },
    {
        prefixes: ['deepseek'],
        brand: { name: 'DeepSeek', icon: 'deepseek.color', color: 'linear-gradient(135deg, #4d6bfe, #44a3ec)' }
    },
    {
        prefixes: ['qwen', 'qwq'],
        brand: { name: '通义千问', icon: 'qwen.color', color: 'linear-gradient(135deg, #615cf7, #9b8afb)' }
    },
    {
        prefixes: ['glm', 'chatglm', 'codegeex', 'cogview'],
        brand: { name: '智谱 AI', icon: 'zhipu.color', color: 'linear-gradient(135deg, #3b6cf5, #6366f1)' }
    },
    {
        prefixes: ['llama', 'code-llama', 'codellama'],
        brand: { name: 'Meta', icon: 'meta', color: 'linear-gradient(135deg, #0668E1, #1877f2)' }
    },
    {
        prefixes: ['mistral', 'mixtral', 'codestral', 'pixtral', 'ministral'],
        brand: { name: 'Mistral', icon: 'mistral.color', color: 'linear-gradient(135deg, #f7d046, #f2a900)' }
    },
    {
        prefixes: ['moonshot', 'kimi'],
        brand: { name: 'Moonshot', icon: 'moonshot', color: 'linear-gradient(135deg, #000000, #333333)' }
    },
    {
        prefixes: ['yi-'],
        brand: { name: '零一万物', icon: 'yi.color', color: 'linear-gradient(135deg, #1d4ed8, #3b82f6)' }
    },
    {
        prefixes: ['ernie', 'eb-'],
        brand: { name: '文心一言', icon: 'wenxin.color', color: 'linear-gradient(135deg, #2932e1, #4468f2)' }
    },
    {
        prefixes: ['spark', 'generalv'],
        brand: { name: '讯飞星火', icon: 'spark.color', color: 'linear-gradient(135deg, #0070f3, #00d4ff)' }
    },
    {
        prefixes: ['hunyuan'],
        brand: { name: '腾讯混元', icon: 'hunyuan.color', color: 'linear-gradient(135deg, #00b7ff, #0052d9)' }
    },
    {
        prefixes: ['doubao'],
        brand: { name: '豆包', icon: 'doubao.color', color: 'linear-gradient(135deg, #3b5bdb, #7048e8)' }
    },
    {
        prefixes: ['minimax', 'abab'],
        brand: { name: 'MiniMax', icon: 'minimax.color', color: 'linear-gradient(135deg, #6366f1, #818cf8)' }
    },
    {
        prefixes: ['command', 'embed-'],
        brand: { name: 'Cohere', icon: 'cohere.color', color: 'linear-gradient(135deg, #39594d, #5ba77f)' }
    },
    {
        prefixes: ['phi-'],
        brand: { name: 'Microsoft', icon: 'azure', color: 'linear-gradient(135deg, #00bcf2, #0078d4)' }
    },
    {
        prefixes: ['grok'],
        brand: { name: 'xAI', icon: 'xai', color: 'linear-gradient(135deg, #111, #444)' }
    },
    {
        prefixes: ['step-'],
        brand: { name: '阶跃星辰', icon: 'stepfun', color: 'linear-gradient(135deg, #0066ff, #3399ff)' }
    },
    {
        prefixes: ['flux', 'sd-', 'stable-diffusion', 'sdxl'],
        brand: { name: 'Stability', icon: 'stability', color: 'linear-gradient(135deg, #8b5cf6, #a855f7)' }
    },
];

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BRAND_RULES = BRAND_MAP.map((entry) => ({
    brand: entry.brand,
    prefixMatchers: entry.prefixes.map((prefix) => ({
        prefix,
        boundaryRegex: new RegExp(`(^|[^a-z0-9])${escapeRegExp(prefix)}(?=$|[^a-z0-9])`),
    })),
}));

function collectBrandCandidates(modelName: string): string[] {
    const queue: string[] = [];
    const seen = new Set<string>();
    const push = (value: string) => {
        const normalized = (value || '').trim().toLowerCase();
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        queue.push(normalized);
    };

    push(modelName);
    for (let i = 0; i < queue.length; i += 1) {
        const candidate = queue[i];

        // Strip common route/model wrappers, e.g. "[Summer] gpt-5.2".
        push(candidate.replace(/^(?:\[[^\]]+\]|【[^】]+】)\s*/g, ''));

        if (candidate.startsWith('re:')) {
            push(candidate.slice(3).trim());
        }
        push(candidate.replace(/^\^+/, '').replace(/\$+$/, ''));

        if (candidate.includes('/')) {
            for (const part of candidate.split('/')) push(part);
        }
        if (candidate.includes(':')) {
            for (const part of candidate.split(':')) push(part);
        }
    }

    return queue;
}

export function getBrand(modelName: string): BrandInfo | null {
    const candidates = collectBrandCandidates(modelName);

    // Prefer strict prefix matching first for predictable behavior.
    for (const candidate of candidates) {
        for (const rule of BRAND_RULES) {
            for (const matcher of rule.prefixMatchers) {
                if (candidate.startsWith(matcher.prefix)) return rule.brand;
            }
        }
    }

    // Fallback for regex/model wrappers where brand token appears inside the pattern.
    for (const candidate of candidates) {
        for (const rule of BRAND_RULES) {
            for (const matcher of rule.prefixMatchers) {
                if (matcher.boundaryRegex.test(candidate)) return rule.brand;
            }
        }
    }

    return null;
}

const FALLBACK_COLORS = [
    'linear-gradient(135deg, #4f46e5, #818cf8)',
    'linear-gradient(135deg, #059669, #34d399)',
    'linear-gradient(135deg, #2563eb, #60a5fa)',
    'linear-gradient(135deg, #d946ef, #f0abfc)',
    'linear-gradient(135deg, #ea580c, #fb923c)',
    'linear-gradient(135deg, #0891b2, #22d3ee)',
    'linear-gradient(135deg, #7c3aed, #a78bfa)',
    'linear-gradient(135deg, #dc2626, #f87171)',
];

export function hashColor(name: string): string {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length];
}

function avatarLetters(name: string): string {
    const parts = name.replace(/[-_/.]/g, ' ').trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
}

export function BrandIcon({ model, size = 44 }: { model: string; size?: number }) {
    const brand = getBrand(model);
    const [imgError, setImgError] = useState(false);

    if (brand && !imgError) {
        return (
            <div style={{
                width: size, height: size, borderRadius: 10, background: brand.color,
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                padding: 6,
            }}>
                <img
                    src={`${ICON_CDN}/${brand.icon.replace(/\./g, '-')}.png`}
                    alt={brand.name}
                    style={{ width: size - 14, height: size - 14, objectFit: 'contain', filter: 'brightness(10)' }}
                    onError={() => setImgError(true)}
                    loading="lazy"
                />
            </div>
        );
    }

    return (
        <div className="model-card-avatar" style={{ width: size, height: size, background: hashColor(model), fontSize: size > 32 ? 16 : 10 }}>
            {avatarLetters(model)}
        </div>
    );
}

export function InlineBrandIcon({ model, size = 16 }: { model: string; size?: number }) {
    const brand = getBrand(model);
    const [imgError, setImgError] = useState(false);
    const cdn = useIconCdn();

    if (brand && !imgError) {
        return (
            <img
                src={`${cdn}/${brand.icon.replace(/\./g, '-')}.png`}
                alt={brand.name}
                style={{
                    width: size,
                    height: size,
                    objectFit: 'contain',
                    flexShrink: 0,
                    verticalAlign: 'middle',
                }}
                onError={() => setImgError(true)}
                loading="lazy"
            />
        );
    }

    return null;
}

export function ModelBadge({ model, style }: { model: string; style?: React.CSSProperties }) {
    const brand = getBrand(model);

    // Brand-specific colors for badge background
    const badgeColors: Record<string, { bg: string; border: string; text: string }> = {
        'OpenAI': { bg: 'rgba(16,163,127,0.08)', border: 'rgba(16,163,127,0.2)', text: '#0d9668' },
        'Anthropic': { bg: 'rgba(212,165,116,0.1)', border: 'rgba(212,165,116,0.25)', text: '#9a6e3a' },
        'Google': { bg: 'rgba(66,133,244,0.08)', border: 'rgba(66,133,244,0.2)', text: '#2563eb' },
        'DeepSeek': { bg: 'rgba(77,108,254,0.08)', border: 'rgba(77,108,254,0.2)', text: '#4d6bfe' },
        'xAI': { bg: 'rgba(0,0,0,0.06)', border: 'rgba(0,0,0,0.12)', text: '#333' },
    };

    const brandName = brand?.name || '';
    const colors = badgeColors[brandName] || {
        bg: 'var(--color-primary-light)',
        border: 'rgba(79,70,229,0.15)',
        text: 'var(--color-primary)',
    };

    return (
        <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '2px 10px 2px 6px',
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 500,
            background: colors.bg,
            color: colors.text,
            border: `1px solid ${colors.border}`,
            whiteSpace: 'nowrap',
            ...style,
        }}>
            <InlineBrandIcon model={model} size={14} />
            {model}
        </span>
    );
}
