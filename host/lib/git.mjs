import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const git = async (root, args) => (await run('git', args, { cwd: root })).stdout

// `root` is the features folder. It is its own git repo, not part of the app's repo.

/**
 * Makes `root` a git repo if it is not one. Without its own .git, git would use the app's repo
 * in the parent folder, and the user's features would go into the app's history.
 */
export async function ensureRepo(root) {
  if (!existsSync(join(root, '.git'))) await git(root, ['init', '-q'])
}

/**
 * Commits the changes in root, or only in `paths` (from root). Returns the changed files,
 * or [] when nothing changed. An empty `paths` commits nothing: `git add -A` with no path adds all.
 */
export async function commitFeatures(root, message, paths = ['.']) {
  if (!paths.length) return []
  await git(root, ['add', '-A', '--', ...paths])
  const files = (await git(root, ['diff', '--cached', '--name-only', '--', ...paths])).split('\n').filter(Boolean)
  if (files.length) await git(root, ['commit', '-q', '-m', message, '--', ...paths])
  return files
}

/**
 * Deletes `files` (paths from root) in one "chat: " commit, so undo can bring them back.
 * Changes that are not committed yet (for example, from Claude Code in Terminal) get their
 * own commit first. Then the delete commit has only the delete, and its undo restores the files.
 */
export async function deleteFiles(root, files, message) {
  await commitFeatures(root, 'save: changes made outside the chat')
  await Promise.all(files.map((file) => rm(join(root, file))))
  return commitFeatures(root, message)
}

/**
 * The newest chat commit that is not undone yet. `lines` are "sha<TAB>subject", newest first.
 * An undo commit has the subject "undo: <sha> ...", and it comes before the commit it undoes.
 */
export function pickUndoTarget(lines) {
  const undone = new Set()
  for (const line of lines) {
    const [sha, subject = ''] = line.split('\t')
    const found = subject.match(/^undo: ([0-9a-f]{40})/)
    if (found) undone.add(found[1])
    else if (subject.startsWith('chat: ') && !undone.has(sha)) return { sha, subject }
  }
  return null
}

/** Reverts the newest chat commit that is not undone yet. Returns it, or null. */
export async function undoLast(root) {
  // `git log` fails in a repo with no commits yet: then there is nothing to undo.
  const log = await git(root, ['log', '--format=%H%x09%s', '-n', '500']).catch(() => '')
  const target = pickUndoTarget(log.split('\n').filter(Boolean))
  if (!target) return null
  try {
    await git(root, ['revert', '--no-edit', target.sha])
  } catch (error) {
    await git(root, ['revert', '--abort']).catch(() => {})
    throw new Error(`Could not undo "${target.subject.slice(6)}": ${error.stderr || error.message}`)
  }
  await git(root, ['commit', '--amend', '-q', '-m', `undo: ${target.sha} ${target.subject.slice(6)}`])
  return target
}
