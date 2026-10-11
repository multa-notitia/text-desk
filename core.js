// Text Desk core: reading text out of the game's JSON, editing it in place, and the
// rating rules. No DOM and no network, so core_test.js runs it under node.

const TD = {}

// MD5 of a string's UTF-8 bytes as hex (RFC 1321); voice files are named by it.
TD.md5 = function (str) {
	const b = new TextEncoder().encode(str), n = ((b.length + 8) >> 6) + 1, w = new Uint32Array(n * 16)
	for (let i = 0; i < b.length; i++) w[i >> 2] |= b[i] << ((i % 4) * 8)
	w[b.length >> 2] |= 0x80 << ((b.length % 4) * 8)
	w[n * 16 - 2] = b.length * 8
	const K = [], R = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
	for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0
	let h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]
	for (let o = 0; o < w.length; o += 16) {
		let [a, bb, c, d] = h
		for (let i = 0; i < 64; i++) {
			const r = i >> 4
			const f = r === 0 ? (bb & c) | (~bb & d) : r === 1 ? (d & bb) | (~d & c) : r === 2 ? bb ^ c ^ d : c ^ (bb | ~d)
			const g = r === 0 ? i : r === 1 ? (5 * i + 1) % 16 : r === 2 ? (3 * i + 5) % 16 : (7 * i) % 16
			const t = (a + f + K[i] + w[o + g]) >>> 0, s = R[r * 4 + (i % 4)]
			a = d; d = c; c = bb
			bb = (bb + ((t << s) | (t >>> (32 - s)))) >>> 0
		}
		h = [(h[0] + a) >>> 0, (h[1] + bb) >>> 0, (h[2] + c) >>> 0, (h[3] + d) >>> 0]
	}
	return h.map((x) => [0, 8, 16, 24].map((s) => ((x >>> s) & 255).toString(16).padStart(2, "0")).join("")).join("")
}

// Shown text of a data definition, walked like Loc._collect (scripts/autoload/loc.gd):
// [{path: [...], text}] for every non-empty string under a text key.
TD.textFields = function (def, keys, path = [], out = []) {
	if (Array.isArray(def)) {
		def.forEach((x, i) => TD.textFields(x, keys, path.concat(i), out))
	} else if (def && typeof def === "object") {
		for (const k in def) {
			const v = def[k], p = path.concat(k)
			if (typeof v === "string") {
				if (keys.has(k) && v.trim()) out.push({ path: p, text: v })
			} else if (Array.isArray(v) && keys.has(k)) {
				v.forEach((x, i) => {
					if (typeof x === "string") { if (x.trim()) out.push({ path: p.concat(i), text: x }) }
					else TD.textFields(x, keys, p.concat(i), out)
				})
			} else TD.textFields(v, keys, p, out)
		}
	}
	return out
}

// Where each string value sits in a JSON source: Map of JSON.stringify(path) -> [start, end).
// The game's JSON is laid out by hand, so edits splice the source instead of re-serializing it.
TD.stringSpans = function (src) {
	const spans = new Map()
	let i = 0
	const ws = () => { while (i < src.length && " \t\r\n".includes(src[i])) i++ }
	const str = () => {
		const s = i++
		while (src[i] !== '"') { if (src[i] === "\\") i++; i++ }
		return [s, ++i]
	}
	const val = (p) => {
		ws()
		const c = src[i]
		if (c === "{") {
			i++; ws()
			if (src[i] === "}") { i++; return }
			for (;;) {
				ws()
				const [ks, ke] = str()
				ws(); i++ // :
				val(p.concat(JSON.parse(src.slice(ks, ke))))
				ws()
				if (src[i++] === "}") return
			}
		}
		if (c === "[") {
			i++; ws()
			if (src[i] === "]") { i++; return }
			for (let n = 0; ; n++) {
				val(p.concat(n))
				ws()
				if (src[i++] === "]") return
			}
		}
		if (c === '"') { spans.set(JSON.stringify(p), str()); return }
		while (i < src.length && !" \t\r\n,]}".includes(src[i])) i++
	}
	val([])
	return spans
}

// The source with the string at path replaced by value; throws if there is no string there.
TD.setString = function (src, path, value) {
	const span = TD.stringSpans(src).get(JSON.stringify(path))
	if (!span) throw new Error("no text at " + path.join("/"))
	return src.slice(0, span[0]) + JSON.stringify(value) + src.slice(span[1])
}

// A flat {"English": "Deutsch"} catalog with key set to value: replaced where it is,
// otherwise added as the last entry in the file's own indentation.
TD.setEntry = function (src, key, value) {
	if (!src.trim()) return "{\n\t" + JSON.stringify(key) + ": " + JSON.stringify(value) + "\n}\n"
	if (key in JSON.parse(src)) return TD.setString(src, [key], value)
	const close = src.lastIndexOf("}")
	let last = close - 1
	while (" \t\r\n".includes(src[last])) last--
	const indent = (src.match(/\n([ \t]+)"/) || [, "\t"])[1]
	const entry = indent + JSON.stringify(key) + ": " + JSON.stringify(value)
	return src[last] === "{"
		? src.slice(0, last + 1) + "\n" + entry + "\n" + src.slice(close)
		: src.slice(0, last + 1) + ",\n" + entry + src.slice(last + 1)
}

// Voice file of a line: audio/speech/<lang>/<npc>/<first 10 hex of md5(English)>.ogg,
// as tools/audio/record_speech.py saves it.
TD.speechPath = (lang, npc, english) => `audio/speech/${lang}/${npc}/${TD.md5(english).slice(0, 10)}.ogg`

// Ratings. feedback/text_reviews.json maps "<item>|<lang>|text|audio" to a record:
// {rating, note, at, of, flag, flag_of, history: [...]}. `of` is what was rated (the text,
// or the voice file's git blob sha). A rating holds while `of` is still current; once the
// text or recording changes it shows as changed and the next rating moves it into history.
TD.LOW = 6

TD.state = function (rec, current) {
	if (!rec) return { rating: null, changed: false, open: false }
	const same = rec.of === current
	const rated = rec.rating != null || !!rec.note
	return {
		rating: same ? rec.rating : null,
		changed: rated && !same,
		open: (same && (!!rec.note || (rec.rating != null && rec.rating <= TD.LOW)))
			|| (!!rec.flag && rec.flag_of === current),
	}
}

TD.rate = function (fb, key, current, rating, note, at) {
	const rec = fb[key] || (fb[key] = { history: [] })
	if ((rec.rating != null || rec.note) && rec.of !== current)
		rec.history.push({ rating: rec.rating, note: rec.note, at: rec.at, of: rec.of })
	Object.assign(rec, { rating, note, at, of: current })
	return rec
}

// An edit made on the page: the old text goes into history.
TD.edited = function (fb, key, was, at) {
	const rec = fb[key] || (fb[key] = { history: [] })
	rec.history.push({ at, by: "Richard", was })
	return rec
}

// Something to redo that no rating asked for (German behind its English, a recording
// behind its text). It stays open until `current` changes.
TD.flag = function (fb, key, current, why) {
	const rec = fb[key] || (fb[key] = { history: [] })
	Object.assign(rec, { flag: why, flag_of: current })
	return rec
}

if (typeof module !== "undefined") module.exports = TD
