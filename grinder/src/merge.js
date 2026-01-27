import { news } from './store.js'
import { log } from './log.js'
import { loadTable } from './google-sheets.js'
import { spreadsheetId, axiomSheet } from '../config/google-drive.js'
import { topicsMap } from '../config/topics.js'

export async function merge() {
	let input = await loadTable(spreadsheetId, axiomSheet)
	news.forEach(e => {
		let row = input.find(r => r.sqk == e.sqk)
		if (row && row.json) {
			try {
				let res = JSON.parse(row.json.replace('```json', '').replace('```', ''))
				e.topic ||= topicsMap[res.topic]
				e.priority ||= res.priority
				e.titleRu ||= res.titleRu
				e.summary ||= res.summary
				e.aiTopic = topicsMap[res.topic]
				e.aiPriority = res.priority
				log('ok', row.sqk)
			} catch(e) {
				log(row.sqk, e)
			}
		}
	})
}

if (process.argv[1].endsWith('merge')) await merge()