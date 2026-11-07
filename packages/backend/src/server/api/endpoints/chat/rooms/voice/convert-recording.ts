/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as Redis from 'ioredis';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as Path from 'node:path';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import type { DriveFilesRepository } from '@/models/_.js';
import { DriveService } from '@/core/DriveService.js';
import { InternalStorageService } from '@/core/InternalStorageService.js';
import { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import { ApiError } from '@/server/api/error.js';

const execFileAsync = promisify(execFile);
const CONVERSION_LOCK = 'recording:conversion';
const CONVERSION_TIMEOUT_MS = 90_000;
const CONVERSION_LOCK_MS = 180_000;
const MAX_RECORDING_BYTES = 128 * 1024 * 1024;
const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
	return redis.call('DEL', KEYS[1])
end
return 0
`;

// arti: turn a recorded voice call (WebM/Opus) into MP3, which players handle more widely
export const meta = {
	tags: ['chat'],

	requireCredential: true,

	kind: 'write:drive',

	limit: {
		duration: 60_000,
		max: 10,
	},

	res: {
		type: 'object',
		optional: false, nullable: true,
		ref: 'DriveFile',
	},

	errors: {
		noSuchFile: {
			message: 'No such file.',
			code: 'NO_SUCH_FILE',
			id: '9dece6fd-b314-408e-98ef-daa64f0fed82',
		},
		conversionFailed: {
			message: 'Could not convert the recording.',
			code: 'CONVERSION_FAILED',
			id: 'febe7309-ae3e-47d1-bae1-d393ec0bb877',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		fileId: { type: 'string', format: 'misskey:id' },
	},
	required: ['fileId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		private driveService: DriveService,
		private internalStorageService: InternalStorageService,
		private driveFileEntityService: DriveFileEntityService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const file = await this.driveFilesRepository.findOneBy({ id: ps.fileId });
			if (file == null || file.userId !== me.id) throw new ApiError(meta.errors.noSuchFile);
			if (!file.storedInternal || file.accessKey == null) throw new ApiError(meta.errors.conversionFailed);
			// already converted, or not a recording
			const isAudio = file.type.startsWith('audio/webm');
			const isVideo = file.type.startsWith('video/webm');
			if (!isAudio && !isVideo) return null;
			if (file.size > MAX_RECORDING_BYTES) throw new ApiError(meta.errors.conversionFailed);

			const src = this.internalStorageService.resolvePath(file.accessKey);
			// One conversion across all workers; callers keep the original WebM when busy.
			const lease = randomUUID();
			if (await this.redisClient.set(CONVERSION_LOCK, lease, 'PX', CONVERSION_LOCK_MS, 'NX') !== 'OK') {
				throw new ApiError(meta.errors.conversionFailed);
			}
			let dir: string | null = null;

			try {
				dir = fs.mkdtempSync(Path.join(os.tmpdir(), 'arti-recording-'));
				const dst = Path.join(dir, isVideo ? 'recording.mp4' : 'recording.mp3');
				const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', src], { timeout: 5_000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' });
				const probe = JSON.parse(stdout) as { streams?: { codec_type?: string; width?: number; height?: number }[]; format?: { duration?: string } };
				const videos = probe.streams?.filter(stream => stream.codec_type === 'video') ?? [];
				const maxDuration = isVideo ? 1800 : 7200;
				const duration = Number(probe.format?.duration);
				if ((Number.isFinite(duration) && duration > maxDuration) || videos.length > 1 || videos.some(video => !video.width || !video.height || video.width > 1920 || video.height > 1080)) {
					throw new Error('Recording exceeds conversion limits');
				}
				const inputOptions = ['-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-threads', '2', '-i', src, '-threads', '2', '-filter_threads', '1'];
				const controller = new AbortController();
				// Abort rather than successfully returning a truncated recording (-fs/-t).
				const sizeTimer = setInterval(() => {
					try {
						if (fs.statSync(dst).size > MAX_RECORDING_BYTES) controller.abort();
					} catch (err) {
						if ((err as NodeJS.ErrnoException).code !== 'ENOENT') controller.abort();
					}
				}, 100);
				sizeTimer.unref();
				try {
					await execFileAsync('ffmpeg', [...inputOptions, ...(isVideo
					? ['-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-af', 'alimiter=limit=0.95', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart']
					: ['-map', '0:a:0', '-vn', '-af', 'alimiter=limit=0.95', '-c:a', 'libmp3lame', '-b:a', '320k']), dst], { timeout: CONVERSION_TIMEOUT_MS, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL', signal: controller.signal });
				} finally {
					clearInterval(sizeTimer);
				}
				if (fs.statSync(dst).size > MAX_RECORDING_BYTES) throw new Error('Converted recording is too large');
				const outputProbe = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', dst], { timeout: 5_000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' });
				const outputDuration = Number((JSON.parse(outputProbe.stdout) as { format?: { duration?: string } }).format?.duration);
				if (!Number.isFinite(outputDuration) || outputDuration <= 0 || outputDuration > maxDuration) throw new Error('Converted recording exceeds duration limits');
				const name = file.name.replace(/\.[^.]+$/, '') + (isVideo ? '.mp4' : '.mp3');
				const converted = await this.driveService.addFile({ user: me, path: dst, name, sensitive: file.isSensitive, folderId: file.folderId });
				await this.driveService.deleteFile(file, false, me);
				return await this.driveFileEntityService.pack(converted, { self: true });
			} catch {
				throw new ApiError(meta.errors.conversionFailed);
			} finally {
				try {
					if (dir != null) fs.rmSync(dir, { recursive: true, force: true });
				} finally {
					await this.redisClient.eval(RELEASE_LOCK_SCRIPT, 1, CONVERSION_LOCK, lease);
				}
			}
		});
	}
}
