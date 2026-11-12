/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// kyunet: feat/llm-translation - feat/image-translation
// The LLM gets the image inline: a local vLLM / Ollama may not reach the file's URL, and a downscaled WebP saves tokens.

import { Injectable } from '@nestjs/common';
import { sharpBmp } from '@misskey-dev/sharp-read-bmp';
import type { MiDriveFile } from '@/models/_.js';
import { bindThis } from '@/decorators.js';
import { createTemp } from '@/misc/create-temp.js';
import { DownloadService } from '@/core/DownloadService.js';
import { InternalStorageService } from '@/core/InternalStorageService.js';

export const IMAGE_MAX_SIDE = 1500;
export const IMAGE_WEBP_QUALITY = 85;

@Injectable()
export class KyunetImageLoader {
	constructor(
		private downloadService: DownloadService,
		private internalStorageService: InternalStorageService,
	) {
	}

	/** First frame only (sharp's default for animated input), EXIF-rotated, longest side capped. */
	@bindThis
	public async load(file: MiDriveFile): Promise<{ mime: 'image/webp'; base64: string }> {
		if (file.storedInternal) {
			// webpublicAccessKey is always set for internal files, but the webpublic copy exists only when webpublicUrl does
			const key = file.webpublicUrl != null ? file.webpublicAccessKey : file.accessKey;
			if (key == null) throw new Error(`drive file ${file.id} has no access key`);
			return this.encode(this.internalStorageService.resolvePath(key), file.type);
		}
		const url = file.isLink && file.uri ? file.uri : (file.webpublicUrl ?? file.url);
		const [path, cleanup] = await createTemp();
		try {
			await this.downloadService.downloadUrl(url, path);
			return await this.encode(path, file.type);
		} finally {
			cleanup();
		}
	}

	private async encode(path: string, type: string): Promise<{ mime: 'image/webp'; base64: string }> {
		const buffer = await (await sharpBmp(path, type))
			.rotate()
			.resize({ width: IMAGE_MAX_SIDE, height: IMAGE_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
			.webp({ quality: IMAGE_WEBP_QUALITY })
			.toBuffer();
		return { mime: 'image/webp', base64: buffer.toString('base64') };
	}
}
