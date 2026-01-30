import fs from 'fs'

import { log } from './log.js'
import { logging } from '../config/logging.js'

const maxDataStringLength = Number.isFinite(logging.maxDataStringLength)
	? logging.maxDataStringLength
	: 800

function truncateString(value, limit) {
	if (typeof value !== 'string') return value
	if (value.length <= limit) return value
	let suffix = `... (${value.length - limit} more chars)`
	return value.slice(0, Math.max(0, limit - suffix.length)) + suffix
}

function sanitizeData(value, limit) {
	if (typeof value === 'string') return truncateString(value, limit)
	if (Array.isArray(value)) return value.map(item => sanitizeData(item, limit))
	if (value && typeof value === 'object') {
		let out = {}
		for (let [key, val] of Object.entries(value)) {
			out[key] = sanitizeData(val, limit)
		}
		return out
	}
	return value
}

export function logFetch(data, message, level = 'info') {
	let prefix = level ? `[${level}]` : ''
	if (message) log(prefix, message)
	if (data) {
		let safeData = sanitizeData(data, maxDataStringLength)
		let logFile = logging.fetchLogFile
		if (logFile) {
			let line = JSON.stringify({
				ts: new Date().toISOString(),
				level,
				message,
				...safeData,
			})
			fs.appendFileSync(logFile, line + '\n')
		}
		if (logging.fetchJson) {
			log(prefix, JSON.stringify(safeData))
		}
	}
}
