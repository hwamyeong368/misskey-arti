/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { bindThis } from '@/decorators.js';

export type IceServer = {
	urls: string[];
	username?: string;
	credential?: string;
};

/**
 * arti: TURN credentials for remote voice calls.
 * This fork has no Cloudflare TURN configuration yet, so it returns null and
 * clients fall back to the ICE servers of the room's own LiveKit server.
 * Ported from choco (chalkpe/cherrypick) with the provider removed.
 */
@Injectable()
export class CloudflareTurnService {
	@bindThis
	public async getIceServers(): Promise<IceServer[] | null> {
		return null;
	}
}

/** Validate a list of ICE servers received from another server. */
export function parseIceServers(value: unknown): IceServer[] | null {
	if (!Array.isArray(value)) return null;
	const result: IceServer[] = [];
	for (const item of value) {
		if (typeof item !== 'object' || item == null) return null;
		const { urls, username, credential } = item as Record<string, unknown>;
		if (typeof urls !== 'string' && !(Array.isArray(urls) && urls.every(u => typeof u === 'string'))) return null;
		result.push({
			urls: typeof urls === 'string' ? [urls] : urls,
			username: typeof username === 'string' ? username : undefined,
			credential: typeof credential === 'string' ? credential : undefined,
		});
	}
	return result;
}
