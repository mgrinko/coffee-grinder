import OpenAI from 'openai'

import { verifyMaxChars, verifySummaryMaxChars } from '../config/verification.js'
import { log } from './log.js'

const openai = new OpenAI()

function cleanJsonText(text) {
	if (!text) return ''
	let trimmed = text.trim()
	if (trimmed.startsWith('```')) {
		trimmed = trimmed.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
	}
	if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed
	let match = trimmed.match(/\{[\s\S]*\}/)
	return match ? match[0] : trimmed
}

function clampSummary(text) {
	if (!text) return ''
	return text.length > verifySummaryMaxChars ? text.slice(0, verifySummaryMaxChars) : text
}

export async function verifyArticle({
	title,
	source,
	url,
	text,
	minConfidence,
	failOpen,
}) {
	let payload = {
		title: title || '',
		source: source || '',
		url: url || '',
		text: (text || '').slice(0, verifyMaxChars),
	}
	try {
		let completion = await openai.chat.completions.create({
			model: 'gpt-4o',
			temperature: 0,
			messages: [
				{
					role: 'system',
					content: [
						'You verify that the provided page text matches the news event.',
						'Return ONLY JSON with keys:',
						'- match (boolean)',
						'- confidence (number 0-1)',
						'- reason (string, <=200 chars)',
						'- page_summary (string, <=200 chars)',
					].join(' '),
				},
				{
					role: 'user',
					content: [
						`Title: ${payload.title}`,
						`Source: ${payload.source}`,
						`URL: ${payload.url}`,
						'Text:',
						payload.text,
					].join('\n'),
				},
			],
		})
		let content = completion?.choices?.[0]?.message?.content || ''
		let jsonText = cleanJsonText(content)
		let parsed = JSON.parse(jsonText)
		let match = Boolean(parsed.match)
		let confidence = Number(parsed.confidence ?? 0)
		let reason = clampSummary(String(parsed.reason ?? ''))
		let pageSummary = clampSummary(String(parsed.page_summary ?? parsed.pageSummary ?? ''))
		let ok = match && confidence >= minConfidence
		return {
			ok,
			match,
			confidence,
			reason,
			pageSummary,
			verified: true,
			status: ok ? 'ok' : 'mismatch',
			tokens: completion?.usage?.total_tokens,
		}
	} catch (error) {
		log('verify failed', error)
		if (failOpen) {
			return {
				ok: true,
				match: false,
				confidence: 0,
				reason: 'verification unavailable',
				pageSummary: '',
				verified: false,
				status: 'unverified',
				error,
			}
		}
		return {
			ok: false,
			match: false,
			confidence: 0,
			reason: 'verification failed',
			pageSummary: '',
			verified: false,
			status: 'error',
			error,
		}
	}
}
