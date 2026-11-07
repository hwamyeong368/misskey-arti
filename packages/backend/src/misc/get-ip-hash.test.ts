/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { getIpHash } from './get-ip-hash.js';

describe('IP rate-limit identity', () => {
	test('groups an IPv6 /64 and separates neighbouring subnets', () => {
		expect(getIpHash('2001:db8:1234:5678::1')).toBe(getIpHash('2001:db8:1234:5678:ffff::2'));
		expect(getIpHash('2001:db8:1234:5678::1')).not.toBe(getIpHash('2001:db8:1234:5679::1'));
	});

	test('normalizes IPv4-mapped IPv6 and accepts IPv4 with a port', () => {
		expect(getIpHash('::ffff:192.0.2.13')).toBe(getIpHash('192.0.2.13'));
		expect(getIpHash('192.0.2.13:443')).toBe(getIpHash('192.0.2.13'));
		expect(getIpHash('192.0.2.13')).not.toBe(getIpHash('192.0.2.14'));
	});

	test('keeps the existing IPv4 and IPv6 key encoding', () => {
		expect(getIpHash('192.0.2.13')).toBe('ip-' + 0xc000020dn.toString(36));
		expect(getIpHash('2001:db8:1234:5678::1')).toBe('ip-' + 0x20010db812345678n.toString(36));
	});

	test('rejects malformed input', () => {
		expect(() => getIpHash('not-an-address')).toThrow();
		expect(() => getIpHash('010.0.0.1')).toThrow();
	});
});
