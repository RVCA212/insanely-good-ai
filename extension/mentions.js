// "@" mentions of features in the chat box. Plain functions, so tests can run them.

/** The "@word" that ends at the caret, or null. The "@" must start the text or follow a space. */
export function findMention(text, caret) {
  const match = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret))
  return match ? { start: caret - match[2].length - 1, query: match[2].toLowerCase() } : null
}

/**
 * The features that match the query, best first: name or id starts with it, then a word in
 * them starts with it, then the files or match patterns contain it.
 */
export function searchFeatures(features, query, limit = 8) {
  const rank = (feature) => {
    const name = feature.name.toLowerCase()
    if (name.startsWith(query) || feature.id.startsWith(query)) return 0
    if (`${name} ${feature.id}`.split(/[^a-z0-9]+/).some((word) => word.startsWith(query))) return 1
    if ([...feature.files, ...feature.matches].some((text) => text.toLowerCase().includes(query))) return 2
    return 3
  }
  return features
    .map((feature) => ({ feature, rank: rank(feature) }))
    .filter((item) => item.rank < 3)
    .sort((a, b) => a.rank - b.rank || a.feature.name.localeCompare(b.feature.name))
    .slice(0, limit)
    .map((item) => item.feature)
}

/** What a picked feature puts in the chat box: its files, as paths from the project root. */
export function mentionText(feature) {
  return feature.files.map((file) => `@features/${file}`).join(' ')
}
