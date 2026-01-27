import { log } from './log.js'

export function logFetch(data, message, level = 'info') {
	let prefix = level ? `[${level}]` : ''
	if (message) log(prefix, message)
	if (data) log(prefix, JSON.stringify(data))
}
