import fs from 'fs'

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
import {
	verifyMode,
	verifyMinConfidence,
	verifyShortThreshold,
	verifyFailOpen,
	minAgencyLevel,
} from '../config/verification.js'

const minTextLength = 400
const fetchAttempts = 2
const verifyStatusColumn = 'verifyStatus'

function normalizeKey(value) {
	if (!value) return ''
	return value
		.toLowerCase()
		.replace(/[’'"`.]/g, '')
		.replace(/[-–—]/g, ' ')
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

function getAlternativeArticles(event) {
	let currentSource = normalizeSource(event.source)
	let seen = new Set([currentSource])
	return (event.articles || [])
		.filter(article => article?.gnUrl && article?.source)
		.map(article => ({
			...article,
			level: getAgencyLevel(article.source),
			normalizedSource: normalizeSource(article.source),
		}))
		.filter(article => {
			if (!article.normalizedSource || seen.has(article.normalizedSource)) return false
			if (article.level < minAgencyLevel) return false
			seen.add(article.normalizedSource)
			return true
		})
		.sort((a, b) => b.level - a.level)
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
	logFetch({
		eventId: event?.id,
		title: titleFor(event),
		source: event?.source,
		gnUrl: event?.gnUrl,
		url: event?.url,
		...data,
	}, message, level)
}

function ensureVerifyStatusColumn() {
	if (!news?.headers) return
	if (!news.headers.includes(verifyStatusColumn)) {
		news.headers.push(verifyStatusColumn)
	}
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
	return await decodeGoogleNewsUrl(gnUrl)
}

function extractText(html) {
	if (!html) return
	let text = htmlToText(html)?.trim()
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
				return { ok: false, mismatch: true, verify }
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
				return { ok: false, mismatch: true, verify }
			}
		} else {
			logEvent(event, {
				phase: 'fetch',
				method: 'browse',
				status: 'no_text',
				attempt,
			}, `#${event.id} browse no text (${attempt}/${fetchAttempts})`, 'warn')
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
	event.text = text.slice(0, 30000)
	fs.writeFileSync(`articles/${event.id}.txt`, `${event.titleEn || event.titleRu || ''}\n\n${event.text}`)
}

export async function summarize() {
	news.forEach((e, i) => e.id ||= i + 1)
	ensureVerifyStatusColumn()

	let list = news.filter(e => !e.summary && e.topic !== 'other')

	let stats = { ok: 0, fail: 0 }
	let last = {
		urlDecode: { time: 0, delay: 30e3, increment: 1000 },
		ai: { time: 0, delay: 0 },
		verify: { time: 0, delay: 1000 },
	}
	for (let i = 0; i < list.length; i++) {
		let e = list[i]
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
			if (alternatives.length) {
				logEvent(e, {
					phase: 'fallback_candidates',
					status: 'ok',
					candidates: alternatives.map(a => ({ source: a.source, level: a.level })),
				}, `#${e.id} fallback candidates: ${alternatives.map(a => `${a.source}(${a.level})`).join(', ')}`, 'info')
			} else {
				logEvent(e, {
					phase: 'fallback_candidates',
					status: 'empty',
				}, `#${e.id} no fallback candidates`, 'warn')
			}
			for (let j = 0; j < alternatives.length; j++) {
				let alt = alternatives[j]
				log('Trying alternative source', alt.source, `(level ${alt.level})...`)
				let altUrl = await decodeUrl(alt.gnUrl, last)
				if (!altUrl) {
					logEvent(e, {
						phase: 'fallback_decode',
						status: 'fail',
						candidateSource: alt.source,
						level: alt.level,
					}, `#${e.id} fallback decode failed (${alt.source})`, 'warn')
					continue
				}
				logEvent(e, {
					phase: 'fallback_decode',
					status: 'ok',
					candidateSource: alt.source,
					level: alt.level,
					url: altUrl,
				}, `#${e.id} fallback url decoded (${alt.source})`, 'ok')
				let result = await fetchTextWithRetry(e, altUrl, last, { isFallback: true })
				if (result?.ok) {
					e.source = alt.source
					e.gnUrl = alt.gnUrl
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
			stats.fail++
		} else {
			stats.ok++
		}
	}
	let order = e => (+e.sqk || 999) * 1000 + (topics[e.topic]?.id ?? 99) * 10 + (+e.priority || 10)
	news.sort((a, b) => order(a) - order(b))

	finalyze()
	log('\n', stats)
}

if (process.argv[1].endsWith('summarize')) summarize()
