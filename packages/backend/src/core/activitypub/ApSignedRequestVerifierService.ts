/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as crypto from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import httpSignature from '@peertube/http-signature';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { UserPublickeysRepository, UsersRepository } from '@/models/_.js';
import type { MiRemoteUser } from '@/models/User.js';
import { LoggerService } from '@/core/LoggerService.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';

const REQUIRED_SIGNED_HEADERS = ['(request-target)', 'host', 'date', 'digest'];
const CLOCK_SKEW_MS = 300 * 1000;
const MAX_KEY_ID_LENGTH = 256;

type FailedCheck = 'signature header' | 'host' | 'date' | 'digest' | 'keyId length' | 'key lookup' | 'key owner' | 'signature';

/**
 * arti: verifies an HTTP-signed request from another server on the spot, so a
 * federation endpoint can answer with the sender before replying.
 * Ported from choco (chalkpe/cherrypick).
 */
@Injectable()
export class ApSignedRequestVerifierService {
	private logger: Logger;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.userPublickeysRepository)
		private userPublickeysRepository: UserPublickeysRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('ap-signed-request');
	}

	/**
	 * Returns the owner of the signing key when the signature, host, date and
	 * digest all check out and the key is known locally. Never fetches keys
	 * from remote servers. Returns null on any failed check.
	 */
	@bindThis
	public async verify(request: { method: string; url: string; headers: IncomingHttpHeaders }, rawBody: string): Promise<MiRemoteUser | null> {
		let signature: httpSignature.IParsedSignature;
		try {
			signature = httpSignature.parseRequest(request as IncomingMessage, { headers: REQUIRED_SIGNED_HEADERS, authorizationHeaderName: 'signature', strict: true });
		} catch {
			return this.reject('signature header');
		}
		const keyId = signature.keyId;

		if (request.headers.host !== this.config.host) return this.reject('host', keyId);

		const date = Date.parse(request.headers.date ?? '');
		if (Number.isNaN(date) || Math.abs(Date.now() - date) > CLOCK_SKEW_MS) return this.reject('date', keyId);

		if (!this.digestMatches(request.headers.digest, rawBody)) return this.reject('digest', keyId);

		if (keyId.length > MAX_KEY_ID_LENGTH) return this.reject('keyId length', keyId);

		const key = await this.userPublickeysRepository.findOneBy({ keyId });
		if (key == null) return this.reject('key lookup', keyId);

		const user = await this.usersRepository.findOneBy({ id: key.userId });
		if (user == null || user.isDeleted || user.host == null) return this.reject('key owner', keyId);

		try {
			if (!httpSignature.verifySignature(signature, key.keyPem)) return this.reject('signature', keyId);
		} catch {
			return this.reject('signature', keyId);
		}

		return user as MiRemoteUser;
	}

	@bindThis
	private digestMatches(digest: string | string[] | undefined, rawBody: string): boolean {
		if (typeof digest !== 'string') return false;

		const match = digest.match(/^([a-zA-Z0-9-]+)=(.+)$/);
		if (match == null) return false;
		if (match[1].toUpperCase() !== 'SHA-256') return false;

		return crypto.createHash('sha256').update(rawBody).digest('base64') === match[2];
	}

	@bindThis
	private reject(check: FailedCheck, keyId?: string): null {
		const host = keyId != null ? keyHostOf(keyId) : null;
		this.logger.debug(`Rejected a signed request at the "${check}" check${host != null ? ` (key host: ${host})` : ''}`);
		return null;
	}
}

function keyHostOf(keyId: string): string | null {
	if (keyId.length > MAX_KEY_ID_LENGTH) return null;
	try {
		return new URL(keyId).host || null;
	} catch {
		return null;
	}
}
