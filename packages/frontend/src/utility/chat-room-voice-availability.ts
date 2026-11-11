/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { entities } from 'misskey-js';
import { instance } from '@/instance.js';

/** ルーム画面と一覧で、ローカル・連合通話とアカウントの利用可否を同じ規則で判定する。 */
export function isChatRoomVoiceAvailable(room: entities.ChatRoom | null | undefined, canVoiceCall: boolean): boolean {
	if (room == null || !canVoiceCall || room.isArchived) return false;
	// arti: rooms hosted by another server use that server's remote voice call support
	if (room.owner.host == null) return instance.features?.voiceCall === true;
	const features = instance.features as (typeof instance.features & { remoteVoiceCall?: boolean }) | undefined;
	return features?.remoteVoiceCall === true;
}
