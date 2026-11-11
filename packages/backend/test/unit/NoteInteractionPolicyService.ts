/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { NoteInteractionPolicyService } from '@/core/NoteInteractionPolicyService.js';

// followings as [followerId, followeeId]
function service(followings: [string, string][]) {
	return new NoteInteractionPolicyService({
		exists: async ({ where }: { where: { followerId: string; followeeId: string } }) =>
			followings.some(([a, b]) => a === where.followerId && b === where.followeeId),
	} as never);
}

const note = (replyPolicy: string | null, quotePolicy: string | null = null) => ({
	userId: 'author', replyPolicy, quotePolicy, mentions: ['m'], visibleUserIds: [],
}) as never;

describe('NoteInteractionPolicyService', () => {
	const s = service([['fan', 'author'], ['author', 'friend']]);

	test('no policy allows everyone', async () => {
		expect(await s.isAllowed(note(null), 'reply', 'x')).toBe(true);
	});

	test('the author is always allowed', async () => {
		expect(await s.isAllowed(note('nobody', 'nobody'), 'reply', 'author')).toBe(true);
		expect(await s.isAllowed(note('nobody', 'nobody'), 'quote', 'author')).toBe(true);
	});

	test('nobody', async () => {
		expect(await s.isAllowed(note('nobody'), 'reply', 'fan')).toBe(false);
	});

	test('followers', async () => {
		expect(await s.isAllowed(note('followers'), 'reply', 'fan')).toBe(true);
		expect(await s.isAllowed(note('followers'), 'reply', 'friend')).toBe(false);
	});

	test('following', async () => {
		expect(await s.isAllowed(note('following'), 'reply', 'friend')).toBe(true);
		expect(await s.isAllowed(note('following'), 'reply', 'fan')).toBe(false);
	});

	test('mentioned', async () => {
		expect(await s.isAllowed(note('mentioned'), 'reply', 'm')).toBe(true);
		expect(await s.isAllowed(note('mentioned'), 'reply', 'fan')).toBe(false);
	});

	test('quote policy is separate from reply policy', async () => {
		expect(await s.isAllowed(note('nobody', 'followers'), 'quote', 'fan')).toBe(true);
		expect(await s.isAllowed(note(null, 'nobody'), 'quote', 'fan')).toBe(false);
	});
});
