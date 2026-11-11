/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// arti: per-note reply / quote policy (who may reply to or quote a note). null means everyone, the author is always allowed.

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { FollowingsRepository } from '@/models/_.js';
import type { MiNote } from '@/models/Note.js';
import type { MiUser } from '@/models/User.js';
import { bindThis } from '@/decorators.js';

export type NoteInteractionKind = 'reply' | 'quote';

type PolicyTarget = Pick<MiNote, 'userId' | 'replyPolicy' | 'quotePolicy' | 'mentions' | 'visibleUserIds'>;

@Injectable()
export class NoteInteractionPolicyService {
	constructor(
		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,
	) {
	}

	@bindThis
	public policyOf(note: PolicyTarget, kind: NoteInteractionKind): string | null {
		return kind === 'reply' ? note.replyPolicy : note.quotePolicy;
	}

	/** Whether `actorId` may reply to / quote `note` under the note's policy. */
	@bindThis
	public async isAllowed(note: PolicyTarget, kind: NoteInteractionKind, actorId: MiUser['id']): Promise<boolean> {
		const policy = this.policyOf(note, kind);
		if (policy == null) return true;
		if (actorId === note.userId) return true;
		switch (policy) {
			case 'nobody':
				return false;
			case 'followers':
				return await this.followingsRepository.exists({ where: { followerId: actorId, followeeId: note.userId } });
			case 'following':
				return await this.followingsRepository.exists({ where: { followerId: note.userId, followeeId: actorId } });
			case 'mentioned':
				return note.mentions.includes(actorId) || note.visibleUserIds.includes(actorId);
			default:
				return true;
		}
	}
}
