/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

function hashAddress(ip: string): string {
	if (isIP(ip) === 0) throw new Error('Invalid IP address');
	// Normalize IPv4-mapped IPv6 before choosing the rate-limit subnet.
	const address = ipaddr.process(ip);
	const bytes = address.toByteArray().slice(0, address.kind() === 'ipv6' ? 8 : 4);
	const prefix = bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
	return 'ip-' + prefix.toString(36);
}

export function getIpHash(ip: string): string {
	try {
		// because a single person may control many IPv6 addresses,
		// only a /64 subnet prefix of any IP will be taken into account.
		// (this means for IPv4 the entire address is used)
		return hashAddress(ip);
	} catch (_) {
		return hashAddress(ip.replace(/:[0-9]+$/, ''));
	}
}
