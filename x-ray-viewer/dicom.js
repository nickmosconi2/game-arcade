// Minimal DICOM reader: enough to view CT / MR / X-ray files in the browser.
// Supports implicit and explicit VR little endian, uncompressed pixels, and
// baseline-JPEG frames. Other compressed syntaxes are reported, not decoded.

const TAGS = {
  '00020010': ['transferSyntax', 'UI'],
  '00080060': ['modality', 'CS'],
  '00081030': ['studyDescription', 'LO'],
  '0008103E': ['seriesDescription', 'LO'],
  '00180015': ['bodyPart', 'CS'],
  '00180050': ['sliceThickness', 'DS'],
  '00180088': ['spacingBetweenSlices', 'DS'],
  '00181164': ['imagerPixelSpacing', 'DS'],
  '0020000E': ['seriesUID', 'UI'],
  '00200013': ['instanceNumber', 'IS'],
  '00200032': ['position', 'DS'],
  '00200037': ['orientation', 'DS'],
  '00280002': ['samplesPerPixel', 'US'],
  '00280004': ['photometric', 'CS'],
  '00280006': ['planarConfiguration', 'US'],
  '00280008': ['numberOfFrames', 'IS'],
  '00280010': ['rows', 'US'],
  '00280011': ['columns', 'US'],
  '00280030': ['pixelSpacing', 'DS'],
  '00280100': ['bitsAllocated', 'US'],
  '00280101': ['bitsStored', 'US'],
  '00280103': ['pixelRepresentation', 'US'],
  '00281050': ['windowCenter', 'DS'],
  '00281051': ['windowWidth', 'DS'],
  '00281052': ['rescaleIntercept', 'DS'],
  '00281053': ['rescaleSlope', 'DS'],
};
const LONG_VR = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'SQ', 'UC', 'UR', 'UT', 'UN', 'SV', 'UV']);
const NUMERIC_TEXT = new Set(['DS', 'IS']);
const SYNTAX_NAMES = {
  '1.2.840.10008.1.2.4.50': 'JPEG baseline',
  '1.2.840.10008.1.2.4.51': 'JPEG extended',
  '1.2.840.10008.1.2.4.57': 'JPEG lossless',
  '1.2.840.10008.1.2.4.70': 'JPEG lossless',
  '1.2.840.10008.1.2.4.80': 'JPEG-LS lossless',
  '1.2.840.10008.1.2.4.81': 'JPEG-LS',
  '1.2.840.10008.1.2.4.90': 'JPEG 2000 lossless',
  '1.2.840.10008.1.2.4.91': 'JPEG 2000',
  '1.2.840.10008.1.2.5': 'RLE',
  '1.2.840.10008.1.2.2': 'big endian',
  '1.2.840.10008.1.2.1.99': 'deflated',
};

export class DicomError extends Error {}

const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');

/** Parse one file. Returns metadata plus where the pixels are; pixels are decoded later, per frame. */
export function parseDicom(buffer, name = '') {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const n = buffer.byteLength;
  let pos = 0;
  if (n > 132 && bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4d) pos = 132;
  else if (n < 16) throw new DicomError('not DICOM');
  const m = { name, buffer };
  let explicit = true; // file meta group is always explicit
  let syntaxChecked = pos === 0;
  if (pos === 0) {
    // No preamble: guess the encoding from whether bytes 4-5 look like a VR.
    const a = bytes[4], b = bytes[5];
    explicit = a >= 65 && a <= 90 && b >= 65 && b <= 90;
    const g = view.getUint16(0, true);
    if (g !== 0x0002 && g !== 0x0008) throw new DicomError('not DICOM');
  }

  const text = (off, len) => {
    let s = '';
    for (let i = 0; i < len; i++) { const c = bytes[off + i]; if (c) s += String.fromCharCode(c); }
    return s.trim();
  };

  // Reads one element header at pos. Returns {tag, vr, len, valuePos} and leaves pos at the value.
  const header = (isExplicit) => {
    if (pos + 8 > n) return null;
    const group = view.getUint16(pos, true), elem = view.getUint16(pos + 2, true);
    const tag = hex4(group) + hex4(elem);
    let vr = '', len;
    if (group === 0xfffe) { len = view.getUint32(pos + 4, true); pos += 8; return { tag, vr, len, group }; }
    if (isExplicit || group === 0x0002) {
      vr = String.fromCharCode(bytes[pos + 4], bytes[pos + 5]);
      if (LONG_VR.has(vr)) { len = view.getUint32(pos + 8, true); pos += 12; }
      else { len = view.getUint16(pos + 6, true); pos += 8; }
    } else {
      len = view.getUint32(pos + 4, true); pos += 8;
      vr = TAGS[tag] ? TAGS[tag][1] : '';
    }
    return { tag, vr, len, group };
  };

  // Skips a sequence or item of undefined length by walking its contents.
  const skipUndefined = (isExplicit, depth) => {
    if (depth > 24) throw new DicomError('nesting too deep');
    while (pos < n) {
      const h = header(isExplicit);
      if (!h) return;
      if (h.tag === 'FFFEE0DD' || h.tag === 'FFFEE00D') return;
      if (h.len === 0xffffffff) skipUndefined(isExplicit, depth + 1);
      else pos += h.len;
    }
  };

  while (pos < n) {
    const start = pos;
    const h = header(explicit);
    if (!h) break;
    if (!syntaxChecked && h.group !== 0x0002) {
      // Left the file meta group: switch to the dataset's own encoding and re-read this header.
      syntaxChecked = true;
      const ts = m.transferSyntax || '1.2.840.10008.1.2.1';
      if (ts === '1.2.840.10008.1.2.2' || ts === '1.2.840.10008.1.2.1.99') {
        throw new DicomError(`${SYNTAX_NAMES[ts]} files are not supported yet`);
      }
      explicit = ts !== '1.2.840.10008.1.2';
      pos = start;
      continue;
    }
    if (h.tag === '7FE00010') {
      if (h.len === 0xffffffff) {
        // Encapsulated: first item is the offset table, the rest are compressed fragments.
        const frags = [];
        let first = true;
        while (pos + 8 <= n) {
          const it = header(explicit);
          if (!it || it.tag !== 'FFFEE000') break;
          if (!first && it.len) frags.push(bytes.subarray(pos, pos + it.len));
          first = false;
          pos += it.len;
        }
        m.fragments = frags;
      } else {
        m.pixelOffset = pos;
        m.pixelLength = Math.min(h.len, n - pos);
      }
      break;
    }
    if (h.len === 0xffffffff) { skipUndefined(explicit, 0); continue; }
    const def = TAGS[h.tag];
    if (def && pos + h.len <= n) {
      const [key, dictVr] = def;
      const vr = h.vr || dictVr;
      if (vr === 'US') m[key] = h.len >= 2 ? view.getUint16(pos, true) : 0;
      else {
        const s = text(pos, h.len);
        if (NUMERIC_TEXT.has(dictVr)) {
          const parts = s.split('\\').map(Number).filter((x) => Number.isFinite(x));
          m[key] = parts.length > 1 ? parts : parts[0];
        } else m[key] = s;
      }
    }
    pos += h.len;
  }

  if (!m.rows || !m.columns || (m.pixelOffset === undefined && !m.fragments)) throw new DicomError('no image in file');
  m.transferSyntax = m.transferSyntax || (explicit ? '1.2.840.10008.1.2.1' : '1.2.840.10008.1.2');
  m.frames = Math.max(1, Math.floor(m.numberOfFrames || 1));
  m.samplesPerPixel = m.samplesPerPixel || 1;
  m.bitsAllocated = m.bitsAllocated || 16;
  m.bitsStored = m.bitsStored || m.bitsAllocated;
  m.slope = Number.isFinite(m.rescaleSlope) && m.rescaleSlope !== 0 ? m.rescaleSlope : 1;
  m.intercept = Number.isFinite(m.rescaleIntercept) ? m.rescaleIntercept : 0;
  m.inverted = m.photometric === 'MONOCHROME1';
  const first = (v) => (Array.isArray(v) ? v[0] : v);
  m.windowCenter = first(m.windowCenter);
  m.windowWidth = first(m.windowWidth);
  // Physical size of a pixel in mm. Projection X-rays often only carry the detector spacing.
  const sp = Array.isArray(m.pixelSpacing) && m.pixelSpacing[0] > 0 ? m.pixelSpacing
    : Array.isArray(m.imagerPixelSpacing) && m.imagerPixelSpacing[0] > 0 ? m.imagerPixelSpacing : null;
  m.spacingKnown = !!sp;
  m.rowSpacing = sp ? sp[0] : 0.15;
  m.colSpacing = sp ? sp[1] || sp[0] : 0.15;
  return m;
}

/** Decode one frame to real-world values (HU for CT). Returns Float32Array of rows*columns. */
export async function decodeFrame(m, frame = 0) {
  const count = m.rows * m.columns;
  const out = new Float32Array(count);
  if (m.fragments) {
    const ts = m.transferSyntax;
    if (ts !== '1.2.840.10008.1.2.4.50' && ts !== '1.2.840.10008.1.2.4.51') {
      throw new DicomError(`${SYNTAX_NAMES[ts] || 'This'} compression is not supported yet`);
    }
    const frag = m.frames === 1 && m.fragments.length > 1 ? new Blob(m.fragments) : new Blob([m.fragments[frame]]);
    const bmp = await createImageBitmap(new Blob([frag], { type: 'image/jpeg' }));
    const c = document.createElement('canvas');
    c.width = m.columns; c.height = m.rows;
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0, m.columns, m.rows);
    const px = ctx.getImageData(0, 0, m.columns, m.rows).data;
    for (let i = 0; i < count; i++) out[i] = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) * m.slope + m.intercept;
    return out;
  }
  const spp = m.samplesPerPixel;
  const bps = m.bitsAllocated / 8;
  const frameBytes = count * spp * bps;
  const off = m.pixelOffset + frame * frameBytes;
  if (off + frameBytes > m.buffer.byteLength) throw new DicomError('pixel data is truncated');
  const { slope, intercept } = m;
  if (m.bitsAllocated === 8) {
    const src = new Uint8Array(m.buffer, off, frameBytes);
    if (spp === 3) {
      const planar = m.planarConfiguration === 1;
      for (let i = 0; i < count; i++) {
        const r = planar ? src[i] : src[i * 3], g = planar ? src[count + i] : src[i * 3 + 1], b = planar ? src[2 * count + i] : src[i * 3 + 2];
        out[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      }
    } else for (let i = 0; i < count; i++) out[i] = src[i] * slope + intercept;
  } else if (m.bitsAllocated === 16) {
    const view = new DataView(m.buffer, off, frameBytes);
    const bits = m.bitsStored;
    const mask = bits >= 16 ? 0xffff : (1 << bits) - 1;
    const signBit = 1 << (bits - 1);
    const signed = m.pixelRepresentation === 1;
    for (let i = 0; i < count; i++) {
      let v = view.getUint16(i * 2 * spp, true) & mask;
      if (signed && (v & signBit)) v -= mask + 1;
      out[i] = v * slope + intercept;
    }
  } else if (m.bitsAllocated === 32) {
    const view = new DataView(m.buffer, off, frameBytes);
    const signed = m.pixelRepresentation === 1;
    for (let i = 0; i < count; i++) out[i] = (signed ? view.getInt32(i * 4, true) : view.getUint32(i * 4, true)) * slope + intercept;
  } else throw new DicomError(`${m.bitsAllocated}-bit pixels are not supported`);
  return out;
}

/** Read a .zip (stored or deflated entries) into [{name, buffer}]. */
export async function unzip(buffer) {
  const view = new DataView(buffer);
  const n = buffer.byteLength;
  let eocd = -1;
  for (let i = n - 22; i >= Math.max(0, n - 66000); i--) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new DicomError('zip file is damaged');
  const total = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = [];
  const dec = new TextDecoder();
  for (let i = 0; i < total && p + 46 <= n; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const csize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true), extraLen = view.getUint16(p + 30, true), commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buffer, p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || csize === 0 || name.includes('__MACOSX')) continue;
    const dataPos = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = new Uint8Array(buffer, dataPos, csize);
    if (method === 0) out.push({ name, buffer: raw.slice().buffer });
    else if (method === 8) {
      if (typeof DecompressionStream === 'undefined') throw new DicomError('this browser cannot open compressed zips; pick the files directly');
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      out.push({ name, buffer: await new Response(stream).arrayBuffer() });
    }
  }
  return out;
}

export const isZip = (buffer) => buffer.byteLength > 4 && new DataView(buffer).getUint32(0, true) === 0x04034b50;
