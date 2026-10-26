const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

let H = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
let block = new Uint8Array(64);
let blockLength = 0;
let bytesHashed = 0;

function rotr(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

function processBlock(data, offset) {
  const words = new Uint32Array(64);
  for (let index = 0; index < 16; index++) {
    const at = offset + index * 4;
    words[index] =
      ((data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3]) >>> 0;
  }
  for (let index = 16; index < 64; index++) {
    const x = words[index - 15];
    const y = words[index - 2];
    const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
    const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
    words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
  }

  let [a, b, c, d, e, f, g, h] = H;
  for (let index = 0; index < 64; index++) {
    const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & g);
    const temp1 = (h + s1 + ch + K[index] + words[index]) >>> 0;
    const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const temp2 = (s0 + maj) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + temp1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (temp1 + temp2) >>> 0;
  }

  H[0] = (H[0] + a) >>> 0;
  H[1] = (H[1] + b) >>> 0;
  H[2] = (H[2] + c) >>> 0;
  H[3] = (H[3] + d) >>> 0;
  H[4] = (H[4] + e) >>> 0;
  H[5] = (H[5] + f) >>> 0;
  H[6] = (H[6] + g) >>> 0;
  H[7] = (H[7] + h) >>> 0;
}

function update(bytes) {
  bytesHashed += bytes.length;
  let offset = 0;
  if (blockLength) {
    const needed = 64 - blockLength;
    if (bytes.length < needed) {
      block.set(bytes, blockLength);
      blockLength += bytes.length;
      return;
    }
    block.set(bytes.subarray(0, needed), blockLength);
    processBlock(block, 0);
    offset = needed;
    blockLength = 0;
  }
  while (offset + 64 <= bytes.length) {
    processBlock(bytes, offset);
    offset += 64;
  }
  if (offset < bytes.length) {
    block.set(bytes.subarray(offset), 0);
    blockLength = bytes.length - offset;
  }
}

function finalHex() {
  const high = Math.floor(bytesHashed / 0x20000000) >>> 0;
  const low = (bytesHashed << 3) >>> 0;
  const padLength = blockLength < 56 ? 56 - blockLength : 120 - blockLength;
  const padding = new Uint8Array(padLength + 8);
  padding[0] = 0x80;
  const view = new DataView(padding.buffer);
  view.setUint32(padLength, high);
  view.setUint32(padLength + 4, low);
  update(padding);
  return Array.from(H, (value) => value.toString(16).padStart(8, '0')).join('');
}

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type === 'chunk') {
    update(new Uint8Array(message.buffer));
    self.postMessage({ type: 'progress', hashed: bytesHashed });
  } else if (message.type === 'finish') {
    self.postMessage({ type: 'done', hash: finalHex() });
  }
};
