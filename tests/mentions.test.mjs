import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findMention, mentionText, searchFeatures } from '../extension/mentions.js'

const feature = (id, name, files, matches = ['*://example.com/*']) => ({ id, name, files, matches })
const FEATURES = [
  feature('blind-review-dark', 'Blind review dark mode', ['blind-review-dark.css']),
  feature('dark-mode-everywhere', 'Dark mode everywhere', ['dark-mode-everywhere.js'], ['<all_urls>']),
  feature('github-cool-stars', 'GitHub cool stars', ['github-cool-stars.css'], ['*://github.com/*']),
  feature('github-contribution-stats', 'GitHub contribution stats', ['github-contribution-stats.css', 'github-contribution-stats.js'])
]

test('finds the @word at the caret', () => {
  assert.deepEqual(findMention('@dar', 4), { start: 0, query: 'dar' })
  assert.deepEqual(findMention('fix @Dar', 8), { start: 4, query: 'dar' })
  assert.deepEqual(findMention('fix\n@', 5), { start: 4, query: '' })
  assert.deepEqual(findMention('fix @dar please', 8), { start: 4, query: 'dar' })
})

test('no mention in an email address, after a space, or before the caret', () => {
  assert.equal(findMention('me@dar', 6), null)
  assert.equal(findMention('@dar ', 5), null)
  assert.equal(findMention('hi @dar', 2), null)
})

test('a name that starts with the query comes first', () => {
  assert.deepEqual(
    searchFeatures(FEATURES, 'dar').map((f) => f.id),
    ['dark-mode-everywhere', 'blind-review-dark']
  )
})

test('matches words, then files and match patterns', () => {
  assert.deepEqual(searchFeatures(FEATURES, 'stars').map((f) => f.id), ['github-cool-stars'])
  assert.deepEqual(searchFeatures(FEATURES, 'all_urls').map((f) => f.id), ['dark-mode-everywhere'])
  assert.deepEqual(searchFeatures(FEATURES, 'zzz'), [])
})

test('an empty query lists all features by name, up to the limit', () => {
  assert.deepEqual(
    searchFeatures(FEATURES, '', 3).map((f) => f.id),
    ['blind-review-dark', 'dark-mode-everywhere', 'github-contribution-stats']
  )
})

test('the inserted text names each file from the project root', () => {
  assert.equal(mentionText(FEATURES[0]), '@features/blind-review-dark.css')
  assert.equal(mentionText(FEATURES[3]), '@features/github-contribution-stats.css @features/github-contribution-stats.js')
})
