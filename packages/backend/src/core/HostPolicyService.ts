/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { InstancesRepository } from '@/models/_.js';
import type { MiMeta } from '@/models/Meta.js';
import { bindThis } from '@/decorators.js';
import { UtilityService } from '@/core/UtilityService.js';

/**
 * arti: decides whether this server refuses a remote host, matching the
 * federation and suspension rules used when accepting inbox activities.
 * Ported from choco (chalkpe/cherrypick) without the quarantine checks that
 * this fork does not have.
 */
@Injectable()
export class HostPolicyService {
	constructor(
		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.instancesRepository)
		private instancesRepository: InstancesRepository,

		private utilityService: UtilityService,
	) {
	}

	@bindThis
	public async isRefusedRemoteHost(host: string): Promise<boolean> {
		if (!this.utilityService.isFederationAllowedHost(host)) return true;
		if (this.meta.blockedHosts.includes(host)) return true;

		const instance = await this.instancesRepository.findOneBy({ host: this.utilityService.toPuny(host) });
		if (instance == null) return false;
		return instance.suspensionState !== 'none';
	}
}
