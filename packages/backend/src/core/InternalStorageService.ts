/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import * as Path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { bindThis } from '@/decorators.js';

@Injectable()
export class InternalStorageService {
	private readonly path: string;

	constructor(
		@Inject(DI.config)
		private config: Config,
	) {
		this.path = Path.resolve(this.config.rootDir, 'files');
	}

	@bindThis
	public resolvePath(key: string) {
		return Path.resolve(this.path, key);
	}

	@bindThis
	public read(key: string) {
		return fs.createReadStream(this.resolvePath(key));
	}

	@bindThis
	public saveFromPath(key: string, srcPath: string) {
		fs.mkdirSync(this.path, { recursive: true });
		const dest = this.resolvePath(key);
		try {
			fs.copyFileSync(srcPath, dest);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			// arti: ntfs-3g (fuseblk) rejects copy_file_range for non-root users with EPERM.
			// Fall back to a chunked copy so uploads work on such a files volume.
			if (code !== 'EPERM' && code !== 'EXDEV') throw err;
			copyFileChunked(srcPath, dest);
		}
		return `${this.config.url}/files/${key}`;
	}

	@bindThis
	public saveFromBuffer(key: string, data: Buffer) {
		fs.mkdirSync(this.path, { recursive: true });
		fs.writeFileSync(this.resolvePath(key), data);
		return `${this.config.url}/files/${key}`;
	}

	@bindThis
	public del(key: string) {
		fs.unlink(this.resolvePath(key), () => {});
	}
}

function copyFileChunked(srcPath: string, destPath: string): void {
	const inFd = fs.openSync(srcPath, 'r');
	try {
		const outFd = fs.openSync(destPath, 'w');
		try {
			const buffer = Buffer.allocUnsafe(1024 * 1024);
			let position = 0;
			for (;;) {
				const bytes = fs.readSync(inFd, buffer, 0, buffer.length, position);
				if (bytes === 0) break;
				fs.writeSync(outFd, buffer, 0, bytes);
				position += bytes;
			}
		} finally {
			fs.closeSync(outFd);
		}
	} finally {
		fs.closeSync(inFd);
	}
}
