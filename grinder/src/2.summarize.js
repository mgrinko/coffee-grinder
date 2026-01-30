import fs from 'fs'
import { xml2json } from 'xml-js'
import { JSDOM, VirtualConsole } from 'jsdom'

import { log } from './log.js'
import { sleep } from './sleep.js'
import { news } from './store.js'
import { topics, topicsMap } from '../config/topics.js'
import { agencyLevels, defaultAgencyLevel } from '../config/agencies.js'
import { decodeGoogleNewsUrl } from './google-news.js'
import { fetchArticle } from './fetch-article.js'
import { htmlToText } from './html-to-text.js'
import { ai } from './ai.js'
import { browseArticle, finalyze } from './browse-article.js'
import { logFetch } from './fetch-log.js'
import { verifyArticle } from './verify-article.js'
import { searchExternal, sourceFromUrl } from './external-search.js'
import {
	verifyMode,
	verifyMinConfidence,
	verifyShortThreshold,
	verifyFailOpen,
	minAgencyLevel,
	fallbackMinAgencyLevel,
} from '../config/verification.js'
import { summarizeConfig } from '../config/summarize.js'
import { externalSearch } from '../config/external-search.js'

const minTextLength = 400
const fetchAttempts = 2
const verifyStatusColumn = 'verifyStatus'
const articlesColumn = 'articles'
const googleNewsDefaults = 'hl=en-US&gl=US&ceid=US:en'
const jsdomVirtualConsole = new VirtualConsole()
jsdomVirtualConsole.on('jsdomError', () => {})
jsdomVirtualConsole.on('error', () => {})
jsdomVirtualConsole.on('warn', () => {})

function normalizeKey(value) {
	if (!value) return ''
	return value
		.toLowerCase()
		.replace(/[\u2019'"`.]/g, '')
		.replace(/[\u2013\u2014-]/g, ' ')
		.replace(/^the\s+/, '')
		.replace(/\s+/g, ' ')
		.trim()
}

const agencyLevelsNormalized = Object.fromEntries(
	Object.entries(agencyLevels).map(([key, value]) => [normalizeKey(key), value])
)

function normalizeSource(source) {
	return normalizeKey(source)
}

function getAgencyLevel(source) {
	let key = normalizeSource(source)
	return agencyLevelsNormalized[key] ?? defaultAgencyLevel
}

function normalizeUrl(value) {
	if (!value) return ''
	return String(value).trim()
}

function isGoogleNewsUrl(url) {
	if (!url) return false
	try {
		let host = new URL(url).hostname.replace(/^www\./, '')
		return host === 'news.google.com'
	} catch {
		return false
	}
}

function decodeHtmlEntities(value) {
	if (!value) return ''
	return value
		.replace(/&amp;/gi, '&')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&#x27;/gi, "'")
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&nbsp;/gi, ' ')
}

function extractTitleFromHtml(html) {
	if (!html) return ''
	let metaPatterns = [
		/<meta[^>]+(?:property|name)=["']og:title["'][^>]*>/i,
		/<meta[^>]+(?:property|name)=["']twitter:title["'][^>]*>/i,
		/<meta[^>]+name=["']title["'][^>]*>/i,
	]
	for (let pattern of metaPatterns) {
		let match = html.match(pattern)
		if (!match) continue
		let content = match[0].match(/content=["']([^"']+)["']/i)
		if (content?.[1]) return decodeHtmlEntities(content[1]).trim()
	}
	let title = html.match(/<title[^>]*>([^<]*)<\/title>/i)
	if (title?.[1]) return decodeHtmlEntities(title[1]).trim()
	return ''
}

function backfillMetaFromDisk(event) {
	let changed = false
	let htmlPath = `articles/${event.id}.html`
	if (fs.existsSync(htmlPath)) {
		let html = fs.readFileSync(htmlPath, 'utf8')
		let comment = html.match(/^<!--\s*([\s\S]*?)\s*-->/)
		if (comment?.[1] && isBlank(event.url)) {
			event.url = comment[1].trim()
			changed = true
		}
		let beforeTitle = event.titleEn
		let beforeSource = event.source
		if (isBlank(event.titleEn)) {
			let extracted = extractTitleFromHtml(html)
			if (extracted) event.titleEn = extracted
		}
		if (isBlank(event.source) && event.url && !event.url.includes('news.google.com')) {
			let inferred = sourceFromUrl(event.url)
			if (inferred) event.source = inferred
		}
		if (event.titleEn !== beforeTitle || event.source !== beforeSource) changed = true
	} else if (isBlank(event.source) && event.url && !event.url.includes('news.google.com')) {
		let inferred = sourceFromUrl(event.url)
		if (inferred) {
			event.source = inferred
			changed = true
		}
	}
	return changed
}

function getArticleLink(article) {
	return normalizeUrl(article?.gnUrl || article?.url)
}

function isBlank(value) {
	return !value || String(value).trim().length === 0
}

function parseArticlesValue(value) {
	if (!value) return []
	if (Array.isArray(value)) return value
	if (typeof value !== 'string') return []
	try {
		let parsed = JSON.parse(value)
		return Array.isArray(parsed) ? parsed : []
	} catch {
		return []
	}
}

function setArticles(event, articles) {
	event._articles = articles
}

function getArticles(event) {
	if (Array.isArray(event?._articles)) return event._articles
	if (Array.isArray(event?.articles)) return event.articles
	let parsed = parseArticlesValue(event?.articles)
	if (parsed.length) {
		event._articles = parsed
	}
	return parsed
}

function parseRelatedArticles(description) {
	if (!description) return []
	try {
		let json = xml2json(description, { compact: true })
		let list = JSON.parse(json)?.ol?.li
		if (!list) return []
		if (!Array.isArray(list)) list = [list]
		return list.map(({ a, font }) => ({
			titleEn: a?._text || '',
			gnUrl: a?._attributes?.href || '',
			source: font?._text || '',
		})).filter(article => article.gnUrl && article.source)
	} catch {
		return []
	}
}

function parseGoogleNewsXml(xml) {
	try {
		let feed = JSON.parse(xml2json(xml, { compact: true }))
		let items = feed?.rss?.channel?.item
		if (!items) return []
		if (!Array.isArray(items)) items = [items]
		return items.map(event => {
			let articles = parseRelatedArticles(event.description?._text)
			return {
				titleEn: event.title?._text || '',
				gnUrl: event.link?._text || '',
				source: event.source?._text || '',
				date: event.pubDate?._text ? new Date(event.pubDate._text) : null,
				articles,
			}
		}).filter(item => item.gnUrl)
	} catch {
		return []
	}
}

function buildSearchQuery(event) {
	if (!isBlank(event.titleEn)) return `"${event.titleEn}"`
	if (!isBlank(event.titleRu)) return `"${event.titleRu}"`
	if (!isBlank(event.url)) {
		try {
			let parsed = new URL(event.url)
			let slug = parsed.pathname.split('/').filter(Boolean).pop() || ''
			let terms = slug.replace(/[-_]/g, ' ').trim()
			let host = parsed.hostname.replace(/^www\./, '')
			return terms ? `site:${host} ${terms}` : `site:${host}`
		} catch {
			return event.url
		}
	}
	return ''
}

function normalizeTitleForSearch(title) {
	if (!title) return ''
	let cleaned = title.replace(/\s+\|\s+.*$/, '').replace(/\s+-\s+[^-]+$/, '')
	return cleaned.trim()
}

function normalizeTitleKey(title) {
	let cleaned = normalizeTitleForSearch(title)
	if (!cleaned) return ''
	cleaned = cleaned.replace(/^(live updates:|analysis:|opinion:)\s+/i, '')
	return normalizeKey(cleaned)
}

function extractSearchTermsFromUrl(url) {
	if (!url) return ''
	try {
		let parsed = new URL(url)
		let slug = parsed.pathname.split('/').filter(Boolean).pop() || ''
		if (!slug) return ''
		if (slug.includes('newsml_')) {
			let idx = slug.lastIndexOf(':0-')
			if (idx !== -1) slug = slug.slice(idx + 3)
			slug = slug.replace(/newsml_[^:-]+[:\d-]*/gi, '')
		}
		slug = slug.replace(/^[^a-z0-9]+/i, '')
		let terms = slug.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim()
		return terms
	} catch {
		return ''
	}
}

function buildFallbackSearchQueries(event) {
	let title = normalizeTitleForSearch(event.titleEn) || normalizeTitleForSearch(event.titleRu)
	let queries = []
	if (title) {
		queries.push(`"${title}"`)
		queries.push(title)
		let short = title.split(/\s+/).slice(0, 10).join(' ')
		if (short && short !== title) queries.push(short)
	}
	if (!queries.length && !isBlank(event.url)) {
		let terms = extractSearchTermsFromUrl(event.url)
		if (terms) queries.push(terms)
		else queries.push(event.url)
	}
	let seen = new Set()
	let unique = []
	for (let q of queries) {
		if (!q) continue
		let key = q.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		unique.push(q)
	}
	return unique.slice(0, 3)
}

function scoreGnCandidate(event, candidate) {
	let targetTitle = normalizeTitleKey(event.titleEn || event.titleRu || '')
	let targetSource = normalizeSource(event.source) || normalizeSource(sourceFromUrl(event.url))
	let candTitle = normalizeTitleKey(candidate.titleEn || '')
	let candSource = normalizeSource(candidate.source || '')
	let score = 0
	if (targetTitle && candTitle) {
		if (targetTitle === candTitle) score += 3
		else if (candTitle.includes(targetTitle) || targetTitle.includes(candTitle)) score += 1
	}
	if (targetSource && candSource && targetSource === candSource) score += 2
	return score
}

async function backfillGnUrl(event, last) {
	if (!isBlank(event.gnUrl)) return false
	let queries = buildFallbackSearchQueries(event)
	let shortTitle = normalizeTitleForSearch(event.titleEn || event.titleRu || '')
	if (shortTitle && event.source) queries.unshift(`"${shortTitle}" ${event.source}`)
	if (shortTitle && event.url) {
		try {
			let host = new URL(event.url).hostname.replace(/^www\./, '')
			queries.unshift(`site:${host} ${shortTitle}`)
			if (event.url.includes('reuters.com')) queries.unshift(`site:reuters.com ${shortTitle}`)
		} catch {}
	}
	let seen = new Set()
	let uniqueQueries = []
	for (let query of queries) {
		let key = query.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		uniqueQueries.push(query)
	}
	if (!uniqueQueries.length) return false
	let best = null
	let bestScore = -1
	let usedQuery = ''
	for (let query of uniqueQueries) {
		let results = await searchGoogleNews(query, last)
		if (!results.length) continue
		usedQuery = query
		for (let item of results.slice(0, 6)) {
			let score = scoreGnCandidate(event, item)
			if (score > bestScore) {
				best = item
				bestScore = score
			}
		}
		if (bestScore >= 3) break
	}
	if (!best) {
		if (externalSearch?.enabled && externalSearch.apiKey) {
			let extQueries = []
			if (shortTitle) {
				extQueries.push(`site:news.google.com "${shortTitle}"`)
				if (event.source) extQueries.push(`site:news.google.com "${shortTitle}" ${event.source}`)
			}
			let termsFromUrl = extractSearchTermsFromUrl(event.url)
			if (termsFromUrl) extQueries.push(`site:news.google.com ${termsFromUrl}`)
			for (let query of extQueries.slice(0, 3)) {
				let results = await searchExternal(query)
				let gnResult = results.find(item => item.gnUrl)
				if (gnResult?.gnUrl) {
					event.gnUrl = gnResult.gnUrl
					if (isBlank(event.titleEn) && gnResult.titleEn) event.titleEn = gnResult.titleEn
					if (isBlank(event.source) && gnResult.source) event.source = gnResult.source
					logEvent(event, {
						phase: 'gn_backfill_external',
						status: 'ok',
						query,
						source: gnResult.source,
					}, `#${event.id} google news link backfilled (external)`, 'info')
					return true
				}
			}
		}
		logEvent(event, {
			phase: 'gn_backfill',
			status: 'empty',
			queries: uniqueQueries,
		}, `#${event.id} google news link not found`, 'warn')
		return false
	}
	let changed = false
	if (isBlank(event.titleEn) && best.titleEn) {
		event.titleEn = best.titleEn
		changed = true
	}
	if (isBlank(event.source) && best.source) {
		event.source = best.source
		changed = true
	}
	if (isBlank(event.gnUrl) && best.gnUrl) {
		event.gnUrl = best.gnUrl
		changed = true
	}
	if (changed) {
		logEvent(event, {
			phase: 'gn_backfill',
			status: 'ok',
			query: usedQuery || uniqueQueries[0],
			source: best.source,
		}, `#${event.id} google news link backfilled`, 'info')
	}
	return changed
}

async function searchGoogleNews(query, last) {
	if (!query) return []
	await sleep(last.gnSearch.time + last.gnSearch.delay - Date.now())
	last.gnSearch.time = Date.now()
	let url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${googleNewsDefaults}`
	try {
		let response = await fetch(url)
		if (!response.ok) {
			log('Google News search failed', response.status, response.statusText)
			return []
		}
		let xml = await response.text()
		return parseGoogleNewsXml(xml)
	} catch(e) {
		log('Google News search failed', e)
		return []
	}
}

async function hydrateFromGoogleNews(event, last) {
	let hasMeta = !isBlank(event.titleEn) && !isBlank(event.source) && !isBlank(event.gnUrl)
	let hasArticles = getArticles(event).length > 0
	if (hasMeta && hasArticles) return false

	let query = buildSearchQuery(event)
	let results = await searchGoogleNews(query, last)
	if (!results.length) return false

	let best = results[0]
	if (isBlank(event.titleEn) && best.titleEn) event.titleEn = best.titleEn
	if (isBlank(event.source) && best.source) event.source = best.source
	if (isBlank(event.gnUrl) && best.gnUrl) event.gnUrl = best.gnUrl

	if (!hasArticles) {
		let articles = best.articles?.length
			? best.articles
			: results.map(item => ({
				titleEn: item.titleEn || '',
				gnUrl: item.gnUrl || '',
				source: item.source || '',
			})).filter(item => item.gnUrl && item.source)
		if (articles.length) {
			setArticles(event, articles)
		}
	}

	if (isBlank(event.url) && !isBlank(event.gnUrl)) {
		event.url = await decodeUrl(event.gnUrl, last)
	}

	logEvent(event, {
		phase: 'gn_search',
		status: 'ok',
		query,
	}, `#${event.id} google news metadata filled`, 'info')
	return true
}

function getAlternativeArticles(event) {
	let currentSource = normalizeSource(event.source)
	let currentLink = getArticleLink(event)
	let seen = new Set([currentSource])
	let seenTitle = new Set()
	let items = getArticles(event)
		.filter(article => getArticleLink(article) && article?.source)
		.map(article => ({
			...article,
			url: article?.url || '',
			gnUrl: article?.gnUrl || '',
			level: getAgencyLevel(article.source),
			normalizedSource: normalizeSource(article.source),
			hasDirectUrl: Boolean(article?.url),
			normalizedTitle: normalizeTitleKey(article.titleEn || article.titleRu || ''),
		}))
	let filterByLevel = minLevel => {
		let filtered = []
		for (let article of items) {
			if (!article.normalizedSource) continue
			if (seen.has(article.normalizedSource)) {
				let link = getArticleLink(article)
				if (!currentLink || !link || link === currentLink) continue
			}
			if (article.level < minLevel) continue
			let titleKey = article.normalizedTitle
				? `${article.normalizedSource}|${article.normalizedTitle}`
				: `${article.normalizedSource}|__no_title__`
			if (seenTitle.has(titleKey)) continue
			seenTitle.add(titleKey)
			seen.add(article.normalizedSource)
			filtered.push(article)
		}
		return filtered
	}
	let primary = filterByLevel(minAgencyLevel)
	if (primary.length) return primary.sort((a, b) => (b.level - a.level) || ((b.hasDirectUrl ? 1 : 0) - (a.hasDirectUrl ? 1 : 0)))
	if (fallbackMinAgencyLevel < minAgencyLevel) {
		let relaxed = filterByLevel(fallbackMinAgencyLevel)
		return relaxed.sort((a, b) => (b.level - a.level) || ((b.hasDirectUrl ? 1 : 0) - (a.hasDirectUrl ? 1 : 0)))
	}
	return []
}

function buildExternalAlternatives(event, results) {
	if (!Array.isArray(results) || !results.length) return []
	let currentSource = normalizeSource(event.source)
	let currentLink = getArticleLink(event)
	let seen = new Set([currentSource])
	let seenTitle = new Set()
	let items = results
		.filter(item => getArticleLink(item) && item?.source)
		.map(item => ({
			...item,
			url: item?.url || '',
			gnUrl: item?.gnUrl || '',
			level: getAgencyLevel(item.source),
			normalizedSource: normalizeSource(item.source),
			hasDirectUrl: Boolean(item?.url),
			normalizedTitle: normalizeTitleKey(item.titleEn || item.titleRu || ''),
		}))
	let filtered = []
	for (let item of items) {
		if (!item.normalizedSource) continue
		if (seen.has(item.normalizedSource)) {
			let link = getArticleLink(item)
			if (!currentLink || !link || link === currentLink) continue
		}
		let titleKey = item.normalizedTitle
			? `${item.normalizedSource}|${item.normalizedTitle}`
			: `${item.normalizedSource}|__no_title__`
		if (seenTitle.has(titleKey)) continue
		seenTitle.add(titleKey)
		seen.add(item.normalizedSource)
		filtered.push(item)
	}
	return filtered.sort((a, b) => (b.level - a.level) || ((b.hasDirectUrl ? 1 : 0) - (a.hasDirectUrl ? 1 : 0)))
}

function shouldExpandAlternatives(event, alternatives) {
	if (!alternatives.length) return true
	let currentSource = normalizeSource(event.source)
	if (!currentSource) return true
	return alternatives.every(item => normalizeSource(item.source) === currentSource)
}

function shouldExternalSearch(alternatives) {
	if (!alternatives.length) return true
	return alternatives.every(item => !item.hasDirectUrl)
}

function getAlternativePool(event) {
	let items = getArticles(event)
		.filter(article => getArticleLink(article) && article?.source)
		.map(article => ({
			source: article.source,
			level: getAgencyLevel(article.source),
		}))
	let seen = new Set()
	let pool = []
	for (let item of items) {
		let key = normalizeSource(item.source)
		if (!key || seen.has(key)) continue
		seen.add(key)
		pool.push(item)
	}
	return pool.sort((a, b) => b.level - a.level)
}

function mergeArticles(event, articles) {
	if (!Array.isArray(articles) || !articles.length) return 0
	let existing = getArticles(event)
	let combined = existing.slice()
	let seen = new Set()
	for (let item of combined) {
		let link = getArticleLink(item)
		if (!link || !item?.source) continue
		let key = `${normalizeSource(item.source)}|${link}`
		seen.add(key)
	}
	let added = 0
	for (let item of articles) {
		let link = getArticleLink(item)
		if (!link || !item?.source) continue
		let key = `${normalizeSource(item.source)}|${link}`
		if (seen.has(key)) continue
		seen.add(key)
		combined.push(item)
		added++
	}
	if (added) setArticles(event, combined)
	return added
}

function shouldVerify({ isFallback, textLength }) {
	if (verifyMode === 'always') return true
	if (verifyMode === 'fallback') return isFallback
	if (verifyMode === 'short') return textLength < verifyShortThreshold
	return false
}

function titleFor(event) {
	return event.titleEn || event.titleRu || ''
}

function logEvent(event, data, message, level) {
	if (event && data) {
		if (data.phase) event._lastPhase = data.phase
		if (data.status) event._lastStatus = data.status
		if (data.method) event._lastMethod = data.method
		if (data.reason) event._lastReason = data.reason
		if (data.pageSummary) event._lastPageSummary = data.pageSummary
	}
	logFetch({
		eventId: event?.id,
		title: titleFor(event),
		source: event?.source,
		gnUrl: event?.gnUrl,
		url: event?.url,
		...data,
	}, message, level)
}

function ensureColumns(columns) {
	if (!news?.headers) return
	columns.forEach(column => {
		if (!news.headers.includes(column)) {
			news.headers.push(column)
		}
	})
}

function applyVerifyStatus(event, verify) {
	if (!verify) return
	let status = verify.status
	if (status === 'ok' || status === 'unverified' || status === 'skipped') {
		event[verifyStatusColumn] = status
	}
}

function truncate(text, max = 220) {
	if (!text) return ''
	if (text.length <= max) return text
	return text.slice(0, max - 3) + '...'
}

async function decodeUrl(gnUrl, last) {
	await sleep(last.urlDecode.time + last.urlDecode.delay - Date.now())
	last.urlDecode.delay += last.urlDecode.increment
	last.urlDecode.time = Date.now()
	log('Decoding URL...')
	if (!gnUrl) return ''
	if (!isGoogleNewsUrl(gnUrl)) return gnUrl
	return await decodeGoogleNewsUrl(gnUrl)
}

function extractJsonText(document) {
	let scripts = [...document.querySelectorAll('script[type="application/ld+json"]')]
	if (!scripts.length) return
	let buckets = { body: [], text: [], desc: [] }
	let seen = new Set()
	let collect = node => {
		if (!node || seen.has(node)) return
		if (typeof node === 'string') return
		if (Array.isArray(node)) {
			node.forEach(collect)
			return
		}
		if (typeof node !== 'object') return
		seen.add(node)
		if (typeof node.articleBody === 'string') buckets.body.push(node.articleBody)
		if (typeof node.text === 'string') buckets.text.push(node.text)
		if (typeof node.description === 'string') buckets.desc.push(node.description)
		Object.values(node).forEach(collect)
	}
	for (let script of scripts) {
		let raw = script.textContent?.trim()
		if (!raw) continue
		try {
			collect(JSON.parse(raw))
		} catch {
			continue
		}
	}
	let pick = list => list.sort((a, b) => b.length - a.length)[0]
	let candidate =
		pick(buckets.body) ||
		pick(buckets.text) ||
		pick(buckets.desc)
	if (candidate && candidate.length > minTextLength) return candidate.trim()
}

function extractDomText(document) {
	const selectors = [
		'[itemprop="articleBody"]',
		'article',
		'main',
		'.article-body',
		'.article-body__content',
		'.story-body',
		'.content__article-body',
		'.ArticleBody',
		'.ArticleBody-articleBody',
	]
	let best = ''
	for (let selector of selectors) {
		let nodes = [...document.querySelectorAll(selector)]
		for (let node of nodes) {
			let text = htmlToText(node.innerHTML || '')?.trim()
			if (text && text.length > best.length) {
				best = text
			}
		}
	}
	if (best.length > minTextLength) return best
}

function extractText(html) {
	if (!html) return
	let cleaned = html.replace(/<style[\s\S]*?<\/style>/gi, '')
	if (!/<[a-z][\s\S]*>/i.test(cleaned)) {
		let plain = cleaned.trim()
		if (plain.length > minTextLength) return plain
	}
	try {
		let dom = new JSDOM(cleaned, { virtualConsole: jsdomVirtualConsole })
		let doc = dom.window.document
		let jsonText = extractJsonText(doc)
		if (jsonText) return jsonText
		let domText = extractDomText(doc)
		if (domText) return domText
	} catch {}
	let text = htmlToText(cleaned)?.trim()
	if (!text || text.length <= minTextLength) return
	return text
}

async function verifyText({ event, url, text, isFallback, method, attempt, last }) {
	if (!shouldVerify({ isFallback, textLength: text.length })) {
		logEvent(event, {
			phase: 'verify',
			status: 'skipped',
			method,
			attempt,
			textLength: text.length,
		}, `#${event.id} verify skipped (${method})`, 'info')
		return { ok: true, status: 'skipped', verified: false, skipped: true }
	}
	await sleep(last.verify.time + last.verify.delay - Date.now())
	last.verify.time = Date.now()
	let result = await verifyArticle({
		title: titleFor(event),
		source: event.source,
		url,
		text,
		minConfidence: verifyMinConfidence,
		failOpen: verifyFailOpen,
	})
	let status = result?.status || (result?.ok ? 'ok' : (result?.error ? 'error' : 'mismatch'))
	let summarySnippet = result?.pageSummary ? ` | ${truncate(result.pageSummary)}` : ''
	let errorMessage = result?.error ? String(result.error?.message || result.error) : undefined
	let statusMessage = status === 'unverified' ? 'unverified (gpt unavailable)' : status
	logEvent(event, {
		phase: 'verify',
		status,
		method,
		attempt,
		textLength: text.length,
		confidence: result?.confidence,
		reason: result?.reason,
		pageSummary: result?.pageSummary,
		verified: result?.verified,
		error: errorMessage,
		tokens: result?.tokens,
	}, `#${event.id} verify ${statusMessage} (${method})${summarySnippet}`, result?.ok ? 'ok' : 'warn')
	return result
}

async function fetchTextWithRetry(event, url, last, { isFallback = false } = {}) {
	let foundText = false
	for (let attempt = 1; attempt <= fetchAttempts; attempt++) {
		let mismatchResult = null
		let mismatchHtml = null
		let mismatchText = null
		let html = await fetchArticle(url)
		let text = extractText(html)
		if (text) {
			foundText = true
			logEvent(event, {
				phase: 'fetch',
				method: 'fetch',
				status: 'ok',
				attempt,
				textLength: text.length,
			}, `#${event.id} fetch ok (${attempt}/${fetchAttempts})`, 'ok')
			let verify = await verifyText({ event, url, text, isFallback, method: 'fetch', attempt, last })
			if (verify?.ok) {
				return { ok: true, html, text, verify }
			}
			if (verify?.status === 'mismatch') {
				mismatchResult = verify
				mismatchHtml = html
				mismatchText = text
			}
		} else {
			logEvent(event, {
				phase: 'fetch',
				method: 'fetch',
				status: 'no_text',
				attempt,
			}, `#${event.id} fetch no text (${attempt}/${fetchAttempts})`, 'warn')
		}

		html = await browseArticle(url)
		text = extractText(html)
		if (text) {
			foundText = true
			logEvent(event, {
				phase: 'fetch',
				method: 'browse',
				status: 'ok',
				attempt,
				textLength: text.length,
			}, `#${event.id} browse ok (${attempt}/${fetchAttempts})`, 'ok')
			let verify = await verifyText({ event, url, text, isFallback, method: 'browse', attempt, last })
			if (verify?.ok) {
				return { ok: true, html, text, verify }
			}
			if (verify?.status === 'mismatch') {
				mismatchResult = verify
				mismatchHtml = html
				mismatchText = text
			}
		} else {
			logEvent(event, {
				phase: 'fetch',
				method: 'browse',
				status: 'no_text',
				attempt,
			}, `#${event.id} browse no text (${attempt}/${fetchAttempts})`, 'warn')
		}

		if (mismatchResult) {
			return { ok: false, mismatch: true, verify: mismatchResult, html: mismatchHtml, text: mismatchText }
		}
		log(`article text missing (${attempt}/${fetchAttempts})`)
	}
	if (!foundText) {
		logEvent(event, {
			phase: 'fetch',
			status: 'no_text',
			attempts: fetchAttempts,
		}, `#${event.id} no text after ${fetchAttempts} attempts`, 'warn')
	}
}

function saveArticle(event, html, text) {
	fs.writeFileSync(`articles/${event.id}.html`, `<!--\n${event.url}\n-->\n${html || ''}`)
	if (isBlank(event.titleEn) && html) {
		let extracted = extractTitleFromHtml(html)
		if (extracted) event.titleEn = extracted
	}
	if (isBlank(event.source) && event.url && !event.url.includes('news.google.com')) {
		let inferred = sourceFromUrl(event.url)
		if (inferred) event.source = inferred
	}
	event.text = text.slice(0, 30000)
	fs.writeFileSync(`articles/${event.id}.txt`, `${event.titleEn || event.titleRu || ''}\n\n${event.text}`)
}

export async function summarize() {
	news.forEach((e, i) => e.id ||= i + 1)
	ensureColumns([
		'titleEn',
		'titleRu',
		'gnUrl',
		'url',
		'source',
		articlesColumn,
		verifyStatusColumn,
	])

	let list = news.filter(e => {
		if (!summarizeConfig.includeOtherTopics && e.topic === 'other') return false
		if (summarizeConfig.forceResummarize) return true
		if (!summarizeConfig.processVerifiedOk && String(e[verifyStatusColumn] || '').toLowerCase() === 'ok') return false
		return !e.summary
	})

	let stats = { ok: 0, fail: 0 }
	let failures = []
	let externalSearchWarned = false
	let last = {
		urlDecode: { time: 0, delay: 30e3, increment: 1000 },
		ai: { time: 0, delay: 0 },
		verify: { time: 0, delay: 1000 },
		gnSearch: { time: 0, delay: 1000, increment: 0 },
	}
	let backfilled = 0
	let backfilledGn = 0
	for (let e of news) {
		if (backfillMetaFromDisk(e)) backfilled++
		if (await backfillGnUrl(e, last)) backfilledGn++
	}
	if (backfilled) log('backfilled metadata for', backfilled, 'rows')
	if (backfilledGn) log('backfilled google news links for', backfilledGn, 'rows')
	for (let i = 0; i < list.length; i++) {
		let e = list[i]
		e.url = normalizeUrl(e.url)
		e.gnUrl = normalizeUrl(e.gnUrl)
		await hydrateFromGoogleNews(e, last)
		log(`\n#${e.id} [${i + 1}/${list.length}]`, titleFor(e))

		if (!e.url /*&& !restricted.includes(e.source)*/) {
			e.url = await decodeUrl(e.gnUrl, last)
			if (!e.url) {
				logEvent(e, {
					phase: 'decode_url',
					status: 'fail',
				}, `#${e.id} url decode failed`, 'warn')
				await sleep(5*60e3)
				i--
				continue
			}
			logEvent(e, {
				phase: 'decode_url',
				status: 'ok',
				url: e.url,
			}, `#${e.id} url decoded`, 'ok')
			log('got', e.url)
		}

		let fetched = false
		if (e.url) {
			if (isBlank(e.source) && e.url && !e.url.includes('news.google.com')) {
				let inferred = sourceFromUrl(e.url)
				if (inferred) e.source = inferred
			}
			log('Fetching', e.source || '', 'article...')
			let result = await fetchTextWithRetry(e, e.url, last)
			if (result?.ok) {
				log('got', result.text.length, 'chars')
				saveArticle(e, result.html, result.text)
				applyVerifyStatus(e, result.verify)
				fetched = true
			} else if (result?.mismatch) {
				logEvent(e, {
					phase: 'verify_mismatch',
					status: 'fail',
					pageSummary: result?.verify?.pageSummary,
					reason: result?.verify?.reason,
				}, `#${e.id} text mismatch, switching to fallback`, 'warn')
			}
		}

		if (!fetched) {
			let alternatives = getAlternativeArticles(e)
			let shouldExpand = shouldExpandAlternatives(e, alternatives)
			let shouldExternal = shouldExternalSearch(alternatives)
			let externalResults = []
			if (shouldExpand && !e._gnExpanded) {
				let queries = buildFallbackSearchQueries(e)
				if (queries.length) {
					let totalAdded = 0
					let usedQuery = ''
					for (let query of queries) {
						let results = await searchGoogleNews(query, last)
						let extra = results.map(item => ({
							titleEn: item.titleEn || '',
							gnUrl: item.gnUrl || '',
							source: item.source || '',
						})).filter(item => item.gnUrl && item.source)
						let added = mergeArticles(e, extra)
						if (added) {
							totalAdded += added
							usedQuery = query
							break
						}
					}
					e._gnExpanded = true
					logEvent(e, {
						phase: 'gn_search_expand',
						status: totalAdded ? 'ok' : 'empty',
						query: usedQuery || queries[0],
						queries,
						added: totalAdded,
						total: getArticles(e).length,
					}, `#${e.id} google news expand ${totalAdded ? `added ${totalAdded}` : 'no results'}`, totalAdded ? 'info' : 'warn')
					alternatives = getAlternativeArticles(e)
					shouldExpand = shouldExpandAlternatives(e, alternatives)
					shouldExternal = shouldExternalSearch(alternatives)
				}
			}
			if (shouldExternal && externalSearch?.enabled && !externalSearch.apiKey && !externalSearchWarned) {
				log('external search disabled (missing SEARCH_API_KEY)')
				externalSearchWarned = true
			}
			if (shouldExternal && !e._externalExpanded && externalSearch?.enabled && externalSearch.apiKey) {
				let queries = buildFallbackSearchQueries(e)
				if (queries.length) {
					let totalAdded = 0
					let usedQuery = ''
					for (let query of queries) {
						let results = await searchExternal(query)
						if (results.length) externalResults = results
						let added = mergeArticles(e, results)
						if (added) {
							totalAdded += added
							usedQuery = query
							break
						}
					}
					e._externalExpanded = true
					logEvent(e, {
						phase: 'external_search',
						status: totalAdded ? 'ok' : 'empty',
						provider: externalSearch.provider,
						query: usedQuery || queries[0],
						queries,
						added: totalAdded,
						total: getArticles(e).length,
					}, `#${e.id} external search ${totalAdded ? `added ${totalAdded}` : 'no results'}`, totalAdded ? 'info' : 'warn')
					alternatives = getAlternativeArticles(e)
					shouldExpand = shouldExpandAlternatives(e, alternatives)
				}
			}
			if (!alternatives.length && externalResults.length) {
				alternatives = buildExternalAlternatives(e, externalResults)
			}
			if (alternatives.length) {
				let bySource = new Map()
				for (let alt of alternatives) {
					let key = normalizeSource(alt.source)
					if (!key) continue
					let existing = bySource.get(key)
					if (!existing) {
						bySource.set(key, { source: alt.source, level: alt.level, count: 1 })
					} else {
						existing.count += 1
						existing.level = Math.max(existing.level, alt.level)
					}
				}
				let sourceList = [...bySource.values()].sort((a, b) => b.level - a.level)
				let listForLog = sourceList.slice(0, 12).map(item => `${item.source}(${item.level})${item.count > 1 ? `x${item.count}` : ''}`).join(', ')
				let moreCount = sourceList.length - 12
				logEvent(e, {
					phase: 'fallback_candidates',
					status: 'ok',
					candidates: sourceList.map(a => ({ source: a.source, level: a.level, count: a.count })),
				}, `#${e.id} fallback candidates: ${listForLog}${moreCount > 0 ? ` ... +${moreCount}` : ''}`, 'info')
			} else {
				logEvent(e, {
					phase: 'fallback_candidates',
					status: 'empty',
				}, `#${e.id} no fallback candidates`, 'warn')
				let pool = getAlternativePool(e)
				if (pool.length) {
					logEvent(e, {
						phase: 'fallback_pool',
						status: 'ok',
						candidates: pool.map(a => ({ source: a.source, level: a.level })),
					}, `#${e.id} fallback pool: ${pool.map(a => `${a.source}(${a.level})`).join(', ')}`, 'info')
				}
			}
			for (let j = 0; j < alternatives.length; j++) {
				let alt = alternatives[j]
				log('Trying alternative source', alt.source, `(level ${alt.level})...`)
				let altUrl = normalizeUrl(alt.url)
				let decodeMethod = altUrl ? 'direct' : 'gn'
				if (!altUrl && alt.gnUrl) {
					altUrl = await decodeUrl(alt.gnUrl, last)
				}
				if (!altUrl) {
					logEvent(e, {
						phase: 'fallback_decode',
						status: 'fail',
						candidateSource: alt.source,
						level: alt.level,
						method: decodeMethod,
					}, `#${e.id} fallback decode failed (${alt.source})`, 'warn')
					continue
				}
				logEvent(e, {
					phase: 'fallback_decode',
					status: 'ok',
					candidateSource: alt.source,
					level: alt.level,
					method: decodeMethod,
					url: altUrl,
				}, `#${e.id} fallback url decoded (${alt.source})`, 'ok')
				let result = await fetchTextWithRetry(e, altUrl, last, { isFallback: true })
				if (result?.ok) {
					if (alt.source) e.source = alt.source
					if (!isBlank(alt.gnUrl)) e.gnUrl = alt.gnUrl
					if (isBlank(e.titleEn) && !isBlank(alt.titleEn)) e.titleEn = alt.titleEn
					e.url = altUrl
					log('got', result.text.length, 'chars')
					saveArticle(e, result.html, result.text)
					applyVerifyStatus(e, result.verify)
					fetched = true
					logEvent(e, {
						phase: 'fallback_selected',
						status: 'ok',
						candidateSource: alt.source,
						level: alt.level,
					}, `#${e.id} fallback selected ${alt.source}`, 'ok')
					break
				} else if (result?.mismatch) {
					logEvent(e, {
						phase: 'fallback_verify_mismatch',
						status: 'fail',
						candidateSource: alt.source,
						level: alt.level,
						pageSummary: result?.verify?.pageSummary,
						reason: result?.verify?.reason,
					}, `#${e.id} fallback text mismatch (${alt.source})`, 'warn')
				}
			}
			if (!fetched) {
				logEvent(e, {
					phase: 'fallback_failed',
					status: 'fail',
				}, `#${e.id} fallback exhausted`, 'warn')
			}
		}

		if (e.text?.length > minTextLength) {
			await sleep(last.ai.time + last.ai.delay - Date.now())
			last.ai.time = Date.now()
			log('Summarizing', e.text.length, 'chars...')
			let res = await ai(e)
			if (res) {
				last.ai.delay = res.delay
				e.topic ||= topicsMap[res.topic]
				e.priority ||= res.priority
				e.titleRu ||= res.titleRu
				e.summary = res.summary
				e.aiTopic = topicsMap[res.topic]
				e.aiPriority = res.priority
			}
		}

		if (!e.summary) {
			logEvent(e, {
				phase: 'summary',
				status: 'missing',
			}, `#${e.id} summary missing`, 'warn')
			failures.push({
				id: e.id,
				title: titleFor(e),
				source: e.source || '',
				url: e.url || '',
				phase: e._lastPhase || '',
				status: e._lastStatus || '',
				method: e._lastMethod || '',
				reason: e._lastReason || '',
			})
			stats.fail++
		} else {
			stats.ok++
		}
	}
	let order = e => (+e.sqk || 999) * 1000 + (topics[e.topic]?.id ?? 99) * 10 + (+e.priority || 10)
	news.sort((a, b) => order(a) - order(b))

	if (failures.length) {
		let limit = summarizeConfig.failSummaryLimit || 0
		log('\nFailed summaries:', failures.length)
		let items = limit > 0 ? failures.slice(0, limit) : failures
		for (let item of items) {
			let meta = [item.phase, item.status, item.method].filter(Boolean).join('/')
			let parts = [item.title, item.source, meta].filter(Boolean)
			if (item.reason) parts.push(item.reason)
			log(`[fail] #${item.id}`, parts.join(' | '))
		}
		if (limit > 0 && failures.length > limit) {
			log(`... ${failures.length - limit} more`)
		}
	}

	finalyze()
	log('\n', stats)
}

if (process.argv[1].endsWith('summarize')) summarize()
