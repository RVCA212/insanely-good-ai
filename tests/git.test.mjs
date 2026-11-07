import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commitFeatures, deleteFiles, ensureRepo, pickUndoTarget, undoLast } from '../host/lib/git.mjs'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

/** A new features folder with its own repo. */
async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'iga-git-'))
  await ensureRepo(root)
  return { root, git: (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }) }
}

test('picks the newest chat commit that is not undone', () => {
  assert.deepEqual(pickUndoTarget([`${B}\tchat: two`, `${A}\tchat: one`]), { sha: B, subject: 'chat: two' })
  assert.deepEqual(pickUndoTarget([`${'c'.repeat(40)}\tundo: ${B} two`, `${B}\tchat: two`, `${A}\tchat: one`]).sha, A)
  assert.equal(pickUndoTarget([`${A}\tinitial`]), null)
})

test('nothing to undo in a repo with no commits', async () => {
  const { root } = await repo()
  assert.equal(await undoLast(root), null)
})

test('features inside the app repo get their own repo, so the app repo stays clean', async () => {
  const app = await mkdtemp(join(tmpdir(), 'iga-app-'))
  const appGit = (...args) => execFileSync('git', args, { cwd: app, encoding: 'utf8' })
  appGit('init', '-q')
  const root = join(app, 'features')
  await mkdir(root)
  await ensureRepo(root)
  await ensureRepo(root) // a second call keeps the repo
  await writeFile(join(root, 'a.css'), 'one')

  assert.deepEqual(await commitFeatures(root, 'chat: first'), ['a.css'])
  assert.equal(execFileSync('git', ['log', '--format=%s'], { cwd: root, encoding: 'utf8' }).trim(), 'chat: first')
  assert.throws(() => appGit('log'), /does not have any commits/)
})

test('commits features, then undoes chat commits in order', async () => {
  const { root, git } = await repo()
  await writeFile(join(root, 'a.css'), 'one')
  assert.deepEqual(await commitFeatures(root, 'chat: first'), ['a.css'])
  await writeFile(join(root, 'a.css'), 'two')
  await commitFeatures(root, 'chat: second')
  assert.deepEqual(await commitFeatures(root, 'chat: nothing'), [])
  assert.equal(git('status', '--porcelain'), '')

  assert.equal((await undoLast(root)).subject, 'chat: second')
  assert.equal(await readFile(join(root, 'a.css'), 'utf8'), 'one')
  assert.equal((await undoLast(root)).subject, 'chat: first')
  assert.ok(existsSync(root)) // git does not remove the repo folder when it becomes empty
  assert.equal(await undoLast(root), null)
})

test('commits only the given files, so two chats get their own commits', async () => {
  const { root, git } = await repo()
  await writeFile(join(root, 'a.css'), 'chat a')
  await writeFile(join(root, 'b.css'), 'chat b, not done')

  assert.deepEqual(await commitFeatures(root, 'chat: a', []), [])
  assert.equal(git('diff', '--cached', '--name-only'), '') // nothing is added
  assert.deepEqual(await commitFeatures(root, 'chat: a', ['a.css']), ['a.css'])
  assert.match(git('status', '--porcelain'), /\?\? b\.css/)
  assert.deepEqual(await commitFeatures(root, 'chat: b'), ['b.css'])
  assert.equal(git('log', '--format=%s').trim(), 'chat: b\nchat: a')
})

test('deletes a feature that was never committed, and undo brings it back', async () => {
  const { root, git } = await repo()
  await writeFile(join(root, 'a.css'), 'one')
  await commitFeatures(root, 'chat: first')
  await writeFile(join(root, 'a.css'), 'edited outside the chat')
  await writeFile(join(root, 'b.js'), 'made outside the chat')

  assert.deepEqual(await deleteFiles(root, ['b.js'], 'chat: delete b'), ['b.js'])
  await assert.rejects(readFile(join(root, 'b.js')))
  assert.equal(git('status', '--porcelain'), '')

  assert.equal((await undoLast(root)).subject, 'chat: delete b')
  assert.equal(await readFile(join(root, 'b.js'), 'utf8'), 'made outside the chat')
  assert.equal(await readFile(join(root, 'a.css'), 'utf8'), 'edited outside the chat')
})

test('deletes the last feature', async () => {
  const { root } = await repo()
  await writeFile(join(root, 'a.css'), 'one')
  await commitFeatures(root, 'chat: first')
  assert.deepEqual(await deleteFiles(root, ['a.css'], 'chat: delete a'), ['a.css'])
  assert.deepEqual(await commitFeatures(root, 'chat: nothing'), [])
})
