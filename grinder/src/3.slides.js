import fs from 'fs'

import { log } from './log.js'
import { news } from './store.js'
import { topics } from '../config/topics.js'
import { presentationExists, createPresentation, addSlide } from './google-slides.js'

export async function slides() {
	log()
	if (!await presentationExists()) {
		news.forEach(e => delete e.sqk)
		await createPresentation()
	}

	let order = e => (+e.sqk || 999) * 1000 + (topics[e.topic]?.id ?? 99) * 10 + (+e.priority || 10)
	news.sort((a, b) => order(a) - order(b))

	let topicSqk = {}
	let sqk = news.reduce((sqk, e) => {
		topicSqk[e.topic] = Math.max(topicSqk[e.topic] || 1, e.topicSqk || 0)
		return Math.max(sqk, e.sqk || 0)
	}, 3)

	let list = news.filter(e => !e.sqk && e.topic !== 'other')
	for (let i = 0; i < list.length; i++) {
		let event = list[i]
		log(`[${i + 1}/${list.length}]`, `${sqk}. ${event.titleEn || event.titleRu}`)
		event.topicSqk = topicSqk[event.topic]++
		let notes = event.topicSqk > (topics[event.topic]?.max || 0) ? 'NOT INDEXED' : ''
		await addSlide({
			sqk,
			topicId: topics[event.topic]?.id,
			notes,
			...event,
		 })
		event.sqk = sqk++
	}

	let screenshots = list.map(e => `${e.sqk}\n${e.url}\n`).join('')
	fs.writeFileSync('../img/screenshots.txt', screenshots)
	log('\nScreenshots list saved')
}

if (process.argv[1].endsWith('slides')) slides()
