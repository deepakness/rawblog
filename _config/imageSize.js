/**
 * Reads intrinsic image dimensions straight from the file header.
 *
 * The build already gets width/height for post and note images from the
 * optimizer cache (_data/cache/image-cache.json), but that cache only covers
 * the JPEG/PNG files inside content/blog and content/raw. Anything else, such
 * as a .webp or .gif dropped into a note, would otherwise end up with no
 * dimensions and so no reserved space, which is a layout shift.
 *
 * This fills that gap without a new dependency and without a manual step: the
 * numbers come from the file itself, so a newly added image is measured on the
 * next build with nothing to remember.
 *
 * Only the header of each format is parsed, so it stays cheap; results are
 * memoised per path for the life of the build.
 */
import fs from "fs";
import path from "path";

const cache = new Map();

/** PNG: IHDR is always the first chunk, width and height are big-endian u32. */
function png(buf) {
	if (buf.length < 24) return null;
	if (buf.readUInt32BE(0) !== 0x89504e47) return null;
	return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** GIF: logical screen descriptor, little-endian u16 pair. */
function gif(buf) {
	if (buf.length < 10 || buf.toString("ascii", 0, 3) !== "GIF") return null;
	return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

/** JPEG: walk the segment chain to the start-of-frame marker. */
function jpeg(buf) {
	if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return null;
	let offset = 2;
	while (offset < buf.length - 9) {
		if (buf[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		const marker = buf[offset + 1];
		// SOF0-3, SOF5-7, SOF9-11, SOF13-15 all carry the frame size; the other
		// 0xC- markers (DHT 0xC4, JPG 0xC8, DAC 0xCC) do not.
		const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
		if (isFrame) {
			return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
		}
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 2;
			continue;
		}
		offset += 2 + buf.readUInt16BE(offset + 2);
	}
	return null;
}

/** WebP: lossy (VP8), lossless (VP8L) and extended (VP8X) each store it differently. */
function webp(buf) {
	if (buf.length < 30) return null;
	if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return null;
	const chunk = buf.toString("ascii", 12, 16);

	if (chunk === "VP8 ") {
		return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
	}
	if (chunk === "VP8L") {
		const bits = buf.readUInt32LE(21);
		return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
	}
	if (chunk === "VP8X") {
		// Canvas size is stored minus one, as two 24-bit little-endian values.
		const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
		const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
		return { width: w + 1, height: h + 1 };
	}
	return null;
}

const READERS = {
	".png": png,
	".gif": gif,
	".jpg": jpeg,
	".jpeg": jpeg,
	".webp": webp,
};

/**
 * @param {string} filePath Absolute or project-relative path to an image.
 * @returns {{width: number, height: number} | null} Null when the file is
 *   missing or the format is not one this reader understands, so callers can
 *   fall back rather than emit a broken attribute.
 */
export function readImageSize(filePath) {
	if (!filePath) return null;
	const key = path.normalize(filePath);
	if (cache.has(key)) return cache.get(key);

	let result = null;
	try {
		const reader = READERS[path.extname(key).toLowerCase()];
		if (reader) {
			// 64KB covers every header above, including JPEGs with bulky EXIF.
			const fd = fs.openSync(key, "r");
			const buf = Buffer.alloc(65536);
			const bytes = fs.readSync(fd, buf, 0, 65536, 0);
			fs.closeSync(fd);
			const size = reader(buf.subarray(0, bytes));
			if (size && size.width > 0 && size.height > 0) result = size;
		}
	} catch {
		result = null;
	}

	cache.set(key, result);
	return result;
}

export function resetImageSizeCache() {
	cache.clear();
}
