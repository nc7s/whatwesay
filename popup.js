browser = typeof browser !== 'undefined' ? browser : chrome

const SOURCE_DISPLAY_NAMES = {
	hn: 'Hacker News',
	lobsters: 'Lobsters',
	lemmy: 'Lemmy',
}

const DEFAULT_CONFIG = {
	lemmyInstance: 'https://lemmy.ml',
}

const searchers = {
	hn: searchHN,
	lobsters: searchLobsters,
	lemmy: searchLemmy.bind(undefined, DEFAULT_CONFIG.lemmyInstance),
}

const AGO_STEPS = [
	{ unit: 'year', base: 86400 * 365, unit: 'year' },
	{ unit: 'month', base: 86400 * 30, unit: 'month' },
	{ unit: 'week', base: 86400 * 7, unit: 'week' },
	{ unit: 'day', base: 86400 },
	{ unit: 'hour', base: 3600 },
	{ unit: 'minute', base: 60 },
]

/* Take it as a TypeScript-ish interface with examples. */
const RESULT_ITEM_EXAMPLE = {
	title: 'Example',
	url: 'https://example.com/something',
	postUrl: 'https://posts.com/p/114514',
	author: 'John Doe',
	authorUrl: 'https://posts.com/~johndoe',
	score: 114,
	commentCount: 51,
}

const aboutTitleEl = document.getElementById('about-title')
const aboutUrlEl = document.getElementById('about-url')
const messageEl = document.getElementById('message')

function writeMessage(message) {
	messageEl.innerHTML = message
}

function timestampToAgo(timestamp) {
	const Y = 86400 * 365
	const MO = 86400 * 30
	const W = 86400 * 7
	const D = 86400
	const H = 3600
	const MIN = 60

	const secondsToNow = (Date.now() - timestamp) / 1000
	let num = 0
	let unit_ = ''

	for (const { unit, base } of AGO_STEPS) {
		if (secondsToNow > base) {
			num = Math.round(secondsToNow / base)
			unit_ = unit
			break
		}
	}

	if (num === 0) {
		num = secondsToNow
		unit_ = 'second'
	}

	return `${num} ${unit_}${num === 1 ? '' : 's'} ago`
}

main()

async function main() {
	/* TODO: add config read/write, incl. lemmy instance */

	const activeTabs = await browser.tabs.query({
		active: true,
		currentWindow: true,
	})
	if (!activeTabs || activeTabs.length === 0) {
		writeMessage('Failed to get active tab.')
		return
	}

	let url = new URL(activeTabs[0].url)

	if (url.protocol === 'about:' || url.protocol === 'chrome:') {
		writeMessage('This is an internal page of the browser.')
		return
	}

	if (url.protocol === 'moz-extension:' || url.protocol === 'chrome-extension:') {
		writeMessage('This is an extension page.')
		return
	}

	const title = activeTabs[0].title
	url.hash = ''
	url = url.toString()
	aboutTitleEl.innerHTML = `about: <b>${activeTabs[0].title}</b>`
	aboutUrlEl.innerText = url

	for (const source of Object.keys(searchers)) {
		queryAndShow(source, { url, title })
	}
}

function setTabStatus(source, status) {
	document.getElementById(`tab-status-${source}`).innerText = `(${status})`
}

function setResults(source, results) {
	const contentEl = document.getElementById(`content-${source}`)
	contentEl.innerHTML = ''

	const listEl = document.createElement('ul')

	/* NOTE(SORT-CRITERIA): This is rather naive, but seems to work. */
	results = results.sort((a, b) => a.score < b.score)

	for (const result of results) {
		const itemEl = document.createElement('li')

		itemEl.innerHTML = `
		<p><a href="${result.url}">${result.title}</a></p>
		<p class="info">
		${timestampToAgo(result.created)} by ${result.author},
		${result.score} point${result.score > 1 ? 's' : ''},
		${result.commentCount} comment${result.commentCount > 1 ? 's' : ''}
		</p>
		`

		listEl.appendChild(itemEl)
	}

	contentEl.appendChild(listEl)
}

async function queryAndShow(source, { url, title }) {
	setTabStatus(source, '…')
	try {
		const items = await searchers[source]({ url, title })
		console.log('queryAndShow', { source, items })
		setResults(source, items)
		setTabStatus(source, items.length)
	} catch (error) {
		console.log('queryAndShow', { source, error })
		setTabStatus(source, 'x')
		document.getElementById(`content-${source}`).innerHTML = `
		<h4>An error occurred:</h4>
		<p>${error}</p>
		`
	}
}

/** Hacker News.
 *
 * Easiest since it's provided by Algolia. Thank you, not only for a free
 * service, but also for an clean and powerful API, that searching with the URL
 * is not any harder.
 */

async function searchHN({ url, title }) {
	const algoliaUrl = `http://hn.algolia.com/api/v1/search?query=${encodeURIComponent(url)}`
	console.log('searchHN', { algoliaUrl })
	const response = await fetch(algoliaUrl)
	if (response.status !== 200) throw 'Request to Algolia search API failed'

	const json = await response.json()
	const results = json.hits
		.filter(item => item.comment_text === undefined)
		.map(item => ({
			title: item.title,
			url: `https://news.ycombinator.com/item?id=${item.story_id}`,
			author: `<a href="https://news.ycombinator.com/user?id=${item.author}">${item.author}</a>`,
			created: item.created_at_i * 1000,
			score: item.points,
			commentCount: item.num_comments,
		}))

	return results
}

/** Lobsters.
 *
 * They brag about their "Integrated search engine", using which, "Searching for
 * a keyword will often bring up relevant stories that don't even mention that
 * keyword in the URL or title."
 *
 * The reality is that searching for a page, whose title is not exactly the same
 * as how the author of the story worded, is likely to have no result. Not to
 * mention searching for the URL. They have a `domain:` pattern, but that's not
 * very useful on big domains. So we use DuckDuckGo, an actual search engine.
 */

const RE_LOBSTERS_TITLE = /<title>(.*?) \|/
const RE_LOBSTERS_CREATED = /span title="(.*?\d+-\d\d-\d\d \d\d:\d\d:\d\d .*?)">/
const RE_LOBSTERS_SCORE = /class="score">(\d+)</
const RE_LOBSTERS_COMMENT_COUNT = /(\d+) comments?/
const RE_LOBSTERS_AUTHOR = /class="[^"]*u-author[^"]*" href="(.*?)">(.*?)</

async function searchLobsters({ url, title }) {
	const firstPassUrl = new URL('https://html.duckduckgo.com/html/')
	firstPassUrl.searchParams.set('q', `site:lobste.rs ${title}`)
	console.log('searchLobsters', { firstPassUrl })
	const firstResponse = await fetch(firstPassUrl)
	if (firstResponse.status !== 200) throw 'DuckDuckGo search failed'

	const firstHtml = await firstResponse.text()
	if (firstHtml.includes('class="no-results"')) return []

	const firstUrls = [...firstHtml.matchAll(/href="(.*?)"/g)].map(match => match[1])
	console.log('searchLobsters', { firstUrls })
	const firstPassCandidates = [...new Set(firstUrls
		.map(url => new URL('https:' + url).searchParams.get('uddg'))
		.map(decodeURIComponent)
	)].filter(l => /lobste.rs\/s\/\w+\/\w+/.test(l))

	console.log('searchLobsters', { firstPassCandidates })

	const results = []

	for (const link of firstPassCandidates) {
		const response = await fetch(link)
		const html = await response.text()
		const urlPos = html.search(url)

		if (urlPos !== -1 && urlPos < html.search('class="story_content"')) {
			/* TODO(LOBSTERS-AUTHOR): They having a complicated page structure
			 * for merged stories. Need to figure out how to properly get the
			 * corresponding author: all stories that are merged into the main
			 * one preserve their author and publish time, while the main one
			 * has this information separated by them.
			 */
			results.push({
				title: RE_LOBSTERS_TITLE.exec(html)[1],
				url: link,
				author: '(TODO)',
				created: Date.parse(RE_LOBSTERS_CREATED.exec(html)[1]),
				score: RE_LOBSTERS_SCORE.exec(html)[1],
				commentCount: RE_LOBSTERS_COMMENT_COUNT.exec(html)[1],
			})
		}
	}

	return results
}

/** Lemmy.
 *
 * It has a nice little API with search functionality, but the way they provide
 * URL search is a bit weird. It's a separate search type named `Url`, apart
 * from `All`. Yeah.
 */

async function searchLemmy(instance, { url, title }) {
	const searchUrl = new URL('/api/v3/search', instance)
	searchUrl.searchParams.append('q', encodeURI(url))
	searchUrl.searchParams.set('type_', 'Url')
	const response = await fetch(searchUrl)

	if (response.status !== 200) throw 'Request to Lemmy search API failed'

	const json = await response.json()
	const results = json.posts.map(entry => {
		const author = entry.creator.name
		const authorUrl = entry.creator.actor_id
		const postUrl = entry.post.ap_id
		const instanceUrl = new URL(postUrl)
		return {
			title: entry.post.name,
			url: entry.post.ap_id,
			author: `
			<a href="${entry.creator.actor_id}">${entry.creator.name}</a>
			on <a href="${instanceUrl.toString()}">${instanceUrl.host}</a>
			`,
			created: Date.parse(entry.post.published),
			score: entry.counts.score,
			commentCount: entry.counts.comments,
		}
	})

	return results
}
