const crypto = require('node:crypto');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_URL_SQL = "CASE WHEN image_version <> '' THEN '/api/products/' || id || '/image?v=' || image_version ELSE '' END AS image_url";
const invalidImage = message => Object.assign(new Error(message), { status: 400 });

function decodeProductImage(dataUrl) {
  if (dataUrl === null) return { image_data: null, image_mime: '', image_version: '' };
  if (typeof dataUrl !== 'string') throw invalidImage('Selecione uma imagem PNG, JPEG ou WebP.');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw invalidImage('Selecione uma imagem PNG, JPEG ou WebP.');
  if (match[2].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
    throw invalidImage('A imagem deve ter no máximo 5 MB.');
  }
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== match[2]) {
    throw invalidImage('A imagem é inválida ou excede 5 MB.');
  }
  const mime = match[1];
  const validPng = mime === 'image/png' && bytes.length >= 45 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 &&
    bytes.toString('ascii', bytes.length - 8, bytes.length - 4) === 'IEND';
  const validJpeg = mime === 'image/jpeg' && bytes.length >= 4 &&
    bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 &&
    bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
  const validWebp = mime === 'image/webp' && bytes.length >= 20 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' &&
    bytes.readUInt32LE(4) === bytes.length - 8;
  if (!validPng && !validJpeg && !validWebp) throw invalidImage('O arquivo não corresponde a uma imagem PNG, JPEG ou WebP.');
  return { image_data: bytes, image_mime: mime, image_version: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function imageLayout(body) {
  const layout = { image_position_x: null, image_position_y: null, image_fit: null };
  for (const key of ['image_position_x', 'image_position_y']) {
    if (!Object.hasOwn(body, key)) continue;
    if (!Number.isInteger(body[key]) || body[key] < 0 || body[key] > 100) {
      throw invalidImage('A posição da foto deve ser um número inteiro de 0 a 100.');
    }
    layout[key] = body[key];
  }
  if (Object.hasOwn(body, 'image_fit')) {
    if (!['cover', 'contain'].includes(body.image_fit)) throw invalidImage('Escolha um enquadramento válido para a foto.');
    layout.image_fit = body.image_fit;
  }
  return layout;
}

module.exports = { MAX_IMAGE_BYTES, IMAGE_URL_SQL, decodeProductImage, imageLayout };
