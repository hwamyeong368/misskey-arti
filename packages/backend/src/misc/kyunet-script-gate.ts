/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// kyunet: Fork-only "script gate" for LLM translation (spec 4.1). Decides only the obvious case
// ("this text is written purely in the target language's script") so the LLM is skipped; anything
// ambiguous goes to the LLM. Keep in sync with packages/frontend/src/utility/kyunet-script-gate.ts.

import * as mfm from 'mfm-js';

/** Share of letters that must be in the target language's script. Latin letters (brand names, handles) are the only other script allowed. */
export const GATE_TARGET_RATIO = 0.7;

export type ScriptKey = 'hangul' | 'kana' | 'han' | 'thai' | 'cyrillic' | 'latin' | 'other';
export type ScriptCounts = Record<ScriptKey, number> & { total: number };

const SCRIPT_TESTS: [ScriptKey, RegExp][] = [
	['hangul', /\p{Script=Hangul}/u],
	['kana', /[\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u],
	['han', /\p{Script_Extensions=Han}/u],
	['thai', /\p{Script=Thai}/u],
	['cyrillic', /\p{Script=Cyrillic}/u],
	['latin', /\p{Script=Latin}/u],
];

/** Target primary language -> scripts that count as "the target language". Everything else except latin is disallowed. */
const TARGET_SCRIPTS: Record<string, ScriptKey[]> = {
	ko: ['hangul'],
	ja: ['kana', 'han'],
	zh: ['han'],
	th: ['thai'],
	ru: ['cyrillic'],
};

const LETTER = /\p{L}/u;

export function primaryLang(targetLang: string): string {
	return targetLang.toLowerCase().split('-')[0];
}

/** Text content only: urls, mentions, hashtags, emoji shortcodes, code and math are dropped; MFM function names are not counted. */
export function extractPlainText(text: string): string {
	const out: string[] = [];
	const walk = (nodes: mfm.MfmNode[]): void => {
		for (const node of nodes) {
			switch (node.type) {
				case 'text':
					out.push(node.props.text);
					break;
				case 'url':
				case 'mention':
				case 'hashtag':
				case 'emojiCode':
				case 'unicodeEmoji':
				case 'blockCode':
				case 'inlineCode':
				case 'mathBlock':
				case 'mathInline':
				case 'search':
					break;
				default:
					if ('children' in node && Array.isArray(node.children)) walk(node.children as mfm.MfmNode[]);
			}
		}
	};
	walk(mfm.parse(text));
	return out.join(' ');
}

export function countScripts(text: string): ScriptCounts {
	const counts: ScriptCounts = { hangul: 0, kana: 0, han: 0, thai: 0, cyrillic: 0, latin: 0, other: 0, total: 0 };
	for (const ch of text) {
		if (!LETTER.test(ch)) continue;
		counts.total++;
		const hit = SCRIPT_TESTS.find(([, re]) => re.test(ch));
		counts[hit ? hit[0] : 'other']++;
	}
	return counts;
}

export function isObviouslyTargetLang(text: string, targetLang: string): boolean {
	const targets = TARGET_SCRIPTS[primaryLang(targetLang)];
	if (targets == null) return false;
	const counts = countScripts(extractPlainText(text));
	if (counts.total === 0) return false;
	const targetCount = targets.reduce((sum, key) => sum + counts[key], 0);
	const disallowed = counts.total - targetCount - counts.latin;
	return disallowed === 0 && targetCount / counts.total >= GATE_TARGET_RATIO;
}
