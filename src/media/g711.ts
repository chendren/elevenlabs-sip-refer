/**
 * G.711 u-law (PCMU) codec — ITU-T standard.
 * Encodes 16-bit linear PCM to 8-bit u-law and back.
 * This is the standard codec for SIP/RTP voice calls (payload type 0).
 */

const BIAS = 0x84; // 132
const CLIP = 32635;

// Precompute decode table for u-law → linear PCM
const ULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const sign = (i & 0x80) ? -1 : 1;
  const exponent = (i >> 4) & 0x07;
  const mantissa = i & 0x0F;
  const magnitude = ((mantissa << 4) + BIAS) << exponent;
  ULAW_DECODE_TABLE[i] = sign * (magnitude - BIAS);
}

// Precompute segment lookup for encoding
const SEGMENT_ENDS = [0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF, 0x1FFF, 0x3FFF, 0x7FFF];

function findSegment(val: number): number {
  for (let i = 0; i < 8; i++) {
    if (val <= SEGMENT_ENDS[i]) return i;
  }
  return 8;
}

/** Encode a single 16-bit linear PCM sample to u-law */
export function linearToUlaw(sample: number): number {
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;

  const segment = findSegment(sample);
  if (segment >= 8) {
    return ~(sign | 0x7F) & 0xFF;
  }

  const mantissa = (sample >> (segment + 3)) & 0x0F;
  const ulawByte = ~(sign | (segment << 4) | mantissa) & 0xFF;
  return ulawByte;
}

/** Decode a single u-law byte to 16-bit linear PCM */
export function ulawToLinear(ulaw: number): number {
  return ULAW_DECODE_TABLE[ulaw & 0xFF];
}

/** Encode a buffer of 16-bit LE PCM samples to u-law */
export function encodePcmToUlaw(pcm: Buffer): Buffer {
  const numSamples = Math.floor(pcm.length / 2);
  const ulaw = Buffer.alloc(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const sample = pcm.readInt16LE(i * 2);
    ulaw[i] = linearToUlaw(sample);
  }

  return ulaw;
}

/** Decode a buffer of u-law samples to 16-bit LE PCM */
export function decodeUlawToPcm(ulaw: Buffer): Buffer {
  const pcm = Buffer.alloc(ulaw.length * 2);

  for (let i = 0; i < ulaw.length; i++) {
    const sample = ulawToLinear(ulaw[i]);
    pcm.writeInt16LE(sample, i * 2);
  }

  return pcm;
}

/** Generate silence in u-law encoding (u-law silence = 0xFF) */
export function generateUlawSilence(numSamples: number): Buffer {
  const buf = Buffer.alloc(numSamples);
  buf.fill(0xFF); // u-law silence
  return buf;
}
