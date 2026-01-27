import { compile } from 'html-to-text'

export let htmlToText = compile({
	selectors: [
		{ selector: 'a', options: { ignoreHref: true } },
		{ selector: 'aside', format: 'skip' },
		{ selector: 'footer', format: 'skip' },
		// { selector: 'form', format: 'skip' },
		{ selector: 'h1', options: { uppercase: false } },
		{ selector: 'h2', options: { uppercase: false } },
		{ selector: 'h3', options: { uppercase: false } },
		{ selector: 'h4', options: { uppercase: false } },
		{ selector: 'h5', options: { uppercase: false } },
		{ selector: 'h6', options: { uppercase: false } },
		// { selector: 'header', format: 'skip' },
		{ selector: 'img', format: 'skip' },
		{ selector: 'hr', format: 'skip' },
		{ selector: 'nav', format: 'skip' },
	]
})

