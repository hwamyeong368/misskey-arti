/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { describe, beforeAll, test } from 'vitest';
import { api, makeStreamCatcher, post, signup, uploadFile } from '../utils.js';
import type * as misskey from 'misskey-js';

describe('Drive', () => {
	let alice: misskey.entities.SignupResponse;
	let bob: misskey.entities.SignupResponse;

	beforeAll(async () => {
		alice = await signup({ username: 'alice' });
		bob = await signup({ username: 'bob' });
	}, 1000 * 60 * 2);

	test('ファイルURLからアップロードできる', async () => {
		// utils.js uploadUrl の処理だがAPIレスポンスも見るためここで同様の処理を書いている

		const marker = Math.random().toString();

		const url = 'https://raw.githubusercontent.com/misskey-dev/misskey/develop/packages/backend/test/resources/192.jpg';

		const catcher = makeStreamCatcher(
			alice,
			'main',
			(msg) => msg.type === 'urlUploadFinished' && msg.body.marker === marker,
			(msg) => msg.body.file,
			10 * 1000);

		const res = await api('drive/files/upload-from-url', {
			url,
			marker,
			force: true,
		}, alice);

		const file = await catcher;

		assert.strictEqual(res.status, 204);
		assert.strictEqual(file.name, '192.jpg');
		assert.strictEqual(file.type, 'image/jpeg');
	});

	test('ローカルからアップロードできる', async () => {
		// APIレスポンスを直接使用するので utils.js uploadFile が通過することで成功とする

		const res = await uploadFile(alice, { path: '192.jpg', name: 'テスト画像' });

		assert.strictEqual(res.body?.name, 'テスト画像.jpg');
		assert.strictEqual(res.body.type, 'image/jpeg');
	});

	test('添付ノート一覧を取得できる', async () => {
		const ids = (await Promise.all([uploadFile(alice), uploadFile(alice), uploadFile(alice)])).map(elm => elm.body!.id);

		const note0 = await post(alice, { fileIds: [ids[0]] });
		const note1 = await post(alice, { fileIds: [ids[0], ids[1]] });

		const attached0 = await api('drive/files/attached-notes', { fileId: ids[0] }, alice);
		assert.strictEqual(attached0.body.length, 2);
		assert.strictEqual(attached0.body[0].id, note1.id);
		assert.strictEqual(attached0.body[1].id, note0.id);

		const attached1 = await api('drive/files/attached-notes', { fileId: ids[1] }, alice);
		assert.strictEqual(attached1.body.length, 1);
		assert.strictEqual(attached1.body[0].id, note1.id);

		const attached2 = await api('drive/files/attached-notes', { fileId: ids[2] }, alice);
		assert.strictEqual(attached2.body.length, 0);
	});

	test('添付ノート一覧は他の人から見えない', async () => {
		const file = await uploadFile(alice);

		await post(alice, { fileIds: [file.body!.id] });

		const res = await api('drive/files/attached-notes', { fileId: file.body!.id }, bob);
		assert.strictEqual(res.status, 400);
		assert.strictEqual('error' in res.body, true);
	});
});

describe('Drive folder and file sorting', () => {
	let owner: misskey.entities.SignupResponse;
	let other: misskey.entities.SignupResponse;
	let parentId: string;

	beforeAll(async () => {
		owner = await signup({ username: 'drive_sort_owner' });
		other = await signup({ username: 'drive_sort_other' });
		const parent = await api('drive/folders/create', { name: 'sort-test' }, owner);
		assert.strictEqual(parent.status, 200);
		parentId = parent.body.id;
	}, 1000 * 60 * 2);

	test('folder names are sorted across pages, including duplicate names', async () => {
		for (const name of ['003 한글', '001 English', '002 한글', '001 English', '10 English', '2 English']) {
			const result = await api('drive/folders/create', { name, parentId }, owner);
			assert.strictEqual(result.status, 200);
		}
		const foreign = await api('drive/folders/create', { name: '000 foreign' }, other);
		assert.strictEqual(foreign.status, 200);

		const params = { folderId: parentId, sort: '-name' as const, limit: 100 };
		const all = await api('drive/folders', params, owner);
		assert.strictEqual(all.status, 200);
		assert.deepStrictEqual(all.body.map(folder => folder.name), ['001 English', '001 English', '002 한글', '003 한글', '10 English', '2 English']);

		const paged: string[] = [];
		let cursor: { untilId: string; untilName: string } | undefined;
		for (;;) {
			const page = await api('drive/folders', { ...params, limit: 2, ...cursor }, owner);
			assert.strictEqual(page.status, 200);
			if (page.body.length === 0) break;
			paged.push(...page.body.map(folder => folder.id));
			const last = page.body.at(-1)!;
			cursor = { untilId: last.id, untilName: last.name };
		}
		assert.deepStrictEqual(paged, all.body.map(folder => folder.id));
	});

	test('file names are sorted across pages without omissions or duplicates', async () => {
		for (const name of ['003 English', '001 English', '002 한글', '001 English']) {
			const uploaded = await uploadFile(owner, { name });
			assert.strictEqual(uploaded.status, 200);
			const moved = await api('drive/files/update', { fileId: uploaded.body!.id, folderId: parentId }, owner);
			assert.strictEqual(moved.status, 200);
		}

		const params = { folderId: parentId, sort: '-name' as const, limit: 100 };
		const all = await api('drive/files', params, owner);
		assert.strictEqual(all.status, 200);
		assert.strictEqual(all.body.length, 4);
		const paged: string[] = [];
		let cursor: { untilId: string; untilName: string } | undefined;
		for (;;) {
			const page = await api('drive/files', { ...params, limit: 2, ...cursor }, owner);
			assert.strictEqual(page.status, 200);
			if (page.body.length === 0) break;
			paged.push(...page.body.map(file => file.id));
			const last = page.body.at(-1)!;
			cursor = { untilId: last.id, untilName: last.name };
		}
		assert.deepStrictEqual(paged, all.body.map(file => file.id));
	});

	test('folder date bounds remain independent of name cursors', async () => {
		const parent = await api('drive/folders/create', { name: 'date-cursor' }, owner);
		assert.strictEqual(parent.status, 200);

		const firstFolder = await api('drive/folders/create', { name: 'first', parentId: parent.body.id }, owner);
		const middleFolder = await api('drive/folders/create', { name: 'middle', parentId: parent.body.id }, owner);
		const lastFolder = await api('drive/folders/create', { name: 'last', parentId: parent.body.id }, owner);
		assert.strictEqual(firstFolder.status, 200);
		assert.strictEqual(middleFolder.status, 200);
		assert.strictEqual(lastFolder.status, 200);
		const folderDate = Date.parse(firstFolder.body.createdAt) + 1;
		assert.ok(folderDate <= Date.parse(middleFolder.body.createdAt));
		const folderParams = { folderId: parent.body.id, sort: '-name' as const, untilDate: folderDate, limit: 100 };
		const folders = await api('drive/folders', folderParams, owner);
		const cursorFolders = await api('drive/folders', { ...folderParams, untilId: lastFolder.body.id, untilName: '' }, owner);
		assert.strictEqual(folders.status, 200);
		assert.strictEqual(cursorFolders.status, 200);
		assert.deepStrictEqual(folders.body.map(folder => folder.id), [firstFolder.body.id]);
		assert.deepStrictEqual(cursorFolders.body.map(folder => folder.id), folders.body.map(folder => folder.id));
		const boundedFolders = await api('drive/folders', { ...folderParams, sinceDate: folderDate - 1000, untilId: lastFolder.body.id, untilName: '' }, owner);
		assert.strictEqual(boundedFolders.status, 200);
		assert.deepStrictEqual(boundedFolders.body.map(folder => folder.id), folders.body.map(folder => folder.id));
	});

	test('file date bounds remain independent of name and size cursors', async () => {
		const parent = await api('drive/folders/create', { name: 'file-date-cursor' }, owner);
		assert.strictEqual(parent.status, 200);

		const firstFile = await uploadFile(owner, { name: 'first' });
		const middleFile = await uploadFile(owner, { name: 'middle' });
		const lastFile = await uploadFile(owner, { name: 'last' });
		assert.strictEqual(firstFile.status, 200);
		assert.strictEqual(middleFile.status, 200);
		assert.strictEqual(lastFile.status, 200);
		assert.strictEqual((await api('drive/files/update', { fileId: firstFile.body!.id, folderId: parent.body.id }, owner)).status, 200);
		assert.strictEqual((await api('drive/files/update', { fileId: middleFile.body!.id, folderId: parent.body.id }, owner)).status, 200);
		assert.strictEqual((await api('drive/files/update', { fileId: lastFile.body!.id, folderId: parent.body.id }, owner)).status, 200);
		const fileDate = Date.parse(firstFile.body!.createdAt) + 1;
		assert.ok(fileDate <= Date.parse(middleFile.body!.createdAt));
		for (const sort of ['-name', '-size'] as const) {
			const params = { folderId: parent.body.id, sort, untilDate: fileDate, limit: 100 };
			const files = await api('drive/files', params, owner);
			const cursorFiles = await api('drive/files', { ...params, untilId: lastFile.body!.id, untilName: '', untilSize: 0 }, owner);
			assert.strictEqual(files.status, 200);
			assert.strictEqual(cursorFiles.status, 200);
			assert.deepStrictEqual(files.body.map(file => file.id), [firstFile.body!.id]);
			assert.deepStrictEqual(cursorFiles.body.map(file => file.id), files.body.map(file => file.id), sort);
			const boundedFiles = await api('drive/files', { ...params, sinceDate: fileDate - 1000, untilId: lastFile.body!.id, untilName: '', untilSize: 0 }, owner);
			assert.strictEqual(boundedFiles.status, 200);
			assert.deepStrictEqual(boundedFiles.body.map(file => file.id), files.body.map(file => file.id), sort);
		}
	});

	test.each(['-name', '+name'] as const)('folder %s pagination accepts a supplied name cursor', async (sort) => {
		const parent = await api('drive/folders/create', { name: 'folder-directions' }, owner);
		assert.strictEqual(parent.status, 200);
		for (const name of ['one', 'two', 'one', 'three']) {
			assert.strictEqual((await api('drive/folders/create', { name, parentId: parent.body.id }, owner)).status, 200);
		}
		const params = { folderId: parent.body.id, sort };
		const all = await api('drive/folders', { ...params, limit: 100 }, owner);
		assert.strictEqual(all.status, 200);
		const ids: string[] = [];
		let cursor: { untilId: string; untilName: string } | undefined;
		for (;;) {
			const page = await api('drive/folders', { ...params, limit: 2, ...cursor }, owner);
			assert.strictEqual(page.status, 200);
			if (!page.body.length) break;
			ids.push(...page.body.map(item => item.id));
			assert.ok(ids.length <= all.body.length);
			const last = page.body.at(-1)!;
			cursor = { untilId: last.id, untilName: last.name };
		}
		assert.deepStrictEqual(ids, all.body.map(item => item.id));
	});

	test.each(['delete', 'move'] as const)('folder pagination continues after cursor %s', async (action) => {
		const parent = await api('drive/folders/create', { name: 'folder-cursor-source' }, owner);
		const destination = await api('drive/folders/create', { name: 'folder-cursor-destination' }, owner);
		assert.strictEqual(parent.status, 200);
		assert.strictEqual(destination.status, 200);
		for (const name of ['one', 'two', 'three']) {
			assert.strictEqual((await api('drive/folders/create', { name, parentId: parent.body.id }, owner)).status, 200);
		}
		const params = { folderId: parent.body.id, sort: '-name' as const };
		const all = await api('drive/folders', { ...params, limit: 100 }, owner);
		const first = await api('drive/folders', { ...params, limit: 1 }, owner);
		assert.strictEqual(all.status, 200);
		assert.strictEqual(first.status, 200);
		assert.strictEqual(first.body.length, 1);
		const cursor = first.body[0];
		const changed = action === 'delete'
			? await api('drive/folders/delete', { folderId: cursor.id }, owner)
			: await api('drive/folders/update', { folderId: cursor.id, parentId: destination.body.id }, owner);
		assert.ok(changed.status === 200 || changed.status === 204);
		const rest = await api('drive/folders', { ...params, untilId: cursor.id, untilName: cursor.name }, owner);
		assert.strictEqual(rest.status, 200);
		assert.deepStrictEqual(rest.body.map(item => item.id), all.body.slice(1).map(item => item.id));
	});

	test.each(['delete', 'move'] as const)('file pagination continues after cursor %s', async (action) => {
		for (const sort of ['-name', '-size'] as const) {
			const parent = await api('drive/folders/create', { name: 'file-cursor-source' }, owner);
			const destination = await api('drive/folders/create', { name: 'file-cursor-destination' }, owner);
			assert.strictEqual(parent.status, 200);
			assert.strictEqual(destination.status, 200);
			for (const name of ['one', 'two', 'three']) {
				const uploaded = await uploadFile(owner, { name });
				assert.strictEqual(uploaded.status, 200);
				assert.strictEqual((await api('drive/files/update', { fileId: uploaded.body!.id, folderId: parent.body.id }, owner)).status, 200);
			}
			const params = { folderId: parent.body.id, sort };
			const all = await api('drive/files', { ...params, limit: 100 }, owner);
			const first = await api('drive/files', { ...params, limit: 1 }, owner);
			assert.strictEqual(all.status, 200);
			assert.strictEqual(first.status, 200);
			assert.strictEqual(first.body.length, 1);
			const cursor = first.body[0];
			const changed = action === 'delete'
				? await api('drive/files/delete', { fileId: cursor.id }, owner)
				: await api('drive/files/update', { fileId: cursor.id, folderId: destination.body.id }, owner);
			assert.ok(changed.status === 200 || changed.status === 204);
			const rest = await api('drive/files', { ...params, untilId: cursor.id, untilName: cursor.name, untilSize: cursor.size }, owner);
			assert.strictEqual(rest.status, 200);
			assert.deepStrictEqual(rest.body.map(item => item.id), all.body.slice(1).map(item => item.id), sort);
		}
	});

	test('foreign cursor values cannot return another user’s items', async () => {
		const ownFolder = await api('drive/folders/create', { name: 'own-cursor' }, owner);
		const ownFile = await uploadFile(owner, { name: 'own-cursor' });
		const foreignFolder = await api('drive/folders/create', { name: 'foreign-cursor' }, other);
		const foreignFile = await uploadFile(other, { name: 'foreign-cursor' });
		assert.strictEqual(ownFolder.status, 200);
		assert.strictEqual(ownFile.status, 200);
		assert.strictEqual(foreignFolder.status, 200);
		assert.strictEqual(foreignFile.status, 200);
		const foreignChild = await api('drive/folders/create', { name: 'foreign-child', parentId: foreignFolder.body.id }, other);
		assert.strictEqual(foreignChild.status, 200);
		assert.strictEqual((await api('drive/files/update', { fileId: foreignFile.body!.id, folderId: foreignFolder.body.id }, other)).status, 200);
		const folders = await api('drive/folders', { sort: '-name', untilId: foreignFolder.body.id, untilName: '', limit: 100 }, owner);
		const files = await api('drive/files', { sort: '-size', untilId: foreignFile.body!.id, untilSize: 0, limit: 100 }, owner);
		assert.strictEqual(folders.status, 200);
		assert.strictEqual(files.status, 200);
		assert.ok(folders.body.some(item => item.id === ownFolder.body.id));
		assert.ok(files.body.some(item => item.id === ownFile.body!.id));
		assert.ok(folders.body.every(item => item.id !== foreignFolder.body.id));
		assert.ok(files.body.every(item => item.id !== foreignFile.body!.id));
		const foreignChildren = await api('drive/folders', { folderId: foreignFolder.body.id, sort: '-name' }, owner);
		const foreignFiles = await api('drive/files', { folderId: foreignFolder.body.id, sort: '-name' }, owner);
		assert.strictEqual(foreignChildren.status, 200);
		assert.strictEqual(foreignFiles.status, 200);
		assert.deepStrictEqual(foreignChildren.body, []);
		assert.deepStrictEqual(foreignFiles.body, []);
	});

	test('folder name pagination also accepts an id-only cursor', async () => {
		const parent = await api('drive/folders/create', { name: 'legacy-folder-cursor' }, owner);
		assert.strictEqual(parent.status, 200);
		for (const name of ['003', '001', '002', '001']) {
			assert.strictEqual((await api('drive/folders/create', { name, parentId: parent.body.id }, owner)).status, 200);
		}

		const params = { folderId: parent.body.id, sort: '-name' as const };
		const all = await api('drive/folders', { ...params, limit: 100 }, owner);
		assert.deepStrictEqual(all.body.map(folder => folder.name), ['001', '001', '002', '003']);
		const ids: string[] = [];
		let untilId: string | undefined;
		for (;;) {
			const page = await api('drive/folders', { ...params, limit: 2, untilId }, owner);
			assert.strictEqual(page.status, 200);
			if (page.body.length === 0) break;
			ids.push(...page.body.map(folder => folder.id));
			untilId = page.body.at(-1)!.id;
			assert.ok(ids.length <= all.body.length, 'pagination must not repeat items');
		}
		assert.deepStrictEqual(ids, all.body.map(folder => folder.id));
	});

	test('file name and size pagination also accept an id-only cursor', async () => {
		const parent = await api('drive/folders/create', { name: 'legacy-file-cursor' }, owner);
		assert.strictEqual(parent.status, 200);
		for (const name of ['003', '001', '002', '001']) {
			const file = await uploadFile(owner, { name });
			assert.strictEqual(file.status, 200);
			assert.strictEqual((await api('drive/files/update', { fileId: file.body!.id, folderId: parent.body.id }, owner)).status, 200);
		}

		for (const sort of ['-name', '+name', '-size', '+size'] as const) {
			const params = { folderId: parent.body.id, sort };
			const all = await api('drive/files', { ...params, limit: 100 }, owner);
			const ids: string[] = [];
			let untilId: string | undefined;
			for (;;) {
				const page = await api('drive/files', { ...params, limit: 2, untilId }, owner);
				assert.strictEqual(page.status, 200);
				if (page.body.length === 0) break;
				ids.push(...page.body.map(file => file.id));
				untilId = page.body.at(-1)!.id;
				assert.ok(ids.length <= all.body.length, 'pagination must not repeat items');
			}
			assert.deepStrictEqual(ids, all.body.map(file => file.id), sort);
		}
	});
});
