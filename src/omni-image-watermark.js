#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import { removeWatermark } from '../node_modules/@pilio/gemini-watermark-remover/src/core/blendModes.js';
import { getEmbeddedAlphaMap } from '../node_modules/@pilio/gemini-watermark-remover/src/core/embeddedAlphaMaps.js';
import {
  computeRegionGradientCorrelation,
  computeRegionSpatialCorrelation,
  interpolateAlphaMap
} from '../node_modules/@pilio/gemini-watermark-remover/src/core/adaptiveDetector.js';
import { removeWatermarkFromFile } from '../node_modules/@pilio/gemini-watermark-remover/src/sdk/node.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const PORTRAIT_BASE_VIDEO = Object.freeze({
  width: 720,
  height: 1280,
  watermarkSize: 48,
  watermarkMargin: 72
});
const LANDSCAPE_BASE_VIDEO = Object.freeze({
  width: 1280,
  height: 720,
  watermarkSize: 48,
  watermarkMargin: 96
});
const FRAME_WATERMARK_MIN_SCORE = 0.22;
const DEFAULT_FRAME_ALPHA_GAIN = 0.6;

const alpha48 = getEmbeddedAlphaMap(48);
const alpha96 = getEmbeddedAlphaMap(96);

function printHelp() {
  console.log(`
Omni image watermark cleaner

Usage:
  npm run clean:image -- <input-file-or-dir> [options]
  node src/omni-image-watermark.js <input-file-or-dir> [options]

Options:
  --output <file>              Output path for a single input file.
  --out-dir <dir>              Output directory. Default: <input folder>/去除水印
  --mode <name>                auto | gemini-image | video-frame. Default: auto
  --frame-alpha-gain <number>  Alpha gain for video-frame fallback. Default: ${DEFAULT_FRAME_ALPHA_GAIN}
  --json                       Print machine-readable result JSON.
  --help                       Show this help.
`);
}

function parseArgs(argv) {
  const options = {
    output: null,
    outDir: null,
    mode: 'auto',
    frameAlphaGain: DEFAULT_FRAME_ALPHA_GAIN,
    json: false
  };
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--output') {
      options.output = argv[++i];
      continue;
    }
    if (arg === '--out-dir') {
      options.outDir = argv[++i];
      continue;
    }
    if (arg === '--mode') {
      options.mode = String(argv[++i] ?? '').trim();
      if (!['auto', 'gemini-image', 'video-frame'].includes(options.mode)) {
        throw new Error('--mode must be one of: auto, gemini-image, video-frame');
      }
      continue;
    }
    if (arg === '--frame-alpha-gain') {
      options.frameAlphaGain = Number(argv[++i]);
      if (!Number.isFinite(options.frameAlphaGain) || options.frameAlphaGain <= 0) {
        throw new Error('--frame-alpha-gain must be a positive number.');
      }
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positionals.push(arg);
  }

  return {
    input: positionals[0] ?? null,
    options
  };
}

function mimeTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function outputFormatFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg';
  if (ext === '.webp') return 'webp';
  return 'png';
}

async function decodeImageData(buffer) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: Uint8ClampedArray.from(data)
  };
}

async function encodeImageData(imageData, context = {}) {
  return encodeRawImageData(imageData, context.filePath);
}

async function encodeRawImageData(imageData, outputPath) {
  let encoder = sharp(Buffer.from(imageData.data), {
    raw: {
      width: imageData.width,
      height: imageData.height,
      channels: 4
    }
  });

  const format = outputFormatFor(outputPath);
  if (format === 'jpeg') {
    encoder = encoder.jpeg({ quality: 95 });
  } else if (format === 'webp') {
    encoder = encoder.webp({ quality: 95 });
  } else {
    encoder = encoder.png();
  }

  return encoder.toBuffer();
}

async function readImageData(inputPath) {
  const { data, info } = await sharp(inputPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data)
  };
}

function resolveAlphaMap(size) {
  if (size === 48) return new Float32Array(alpha48);
  if (size === 96) return new Float32Array(alpha96);
  if (size <= 64) return interpolateAlphaMap(alpha48, 48, size);
  return interpolateAlphaMap(alpha96, 96, size);
}

function predictedVideoFrameRegion(width, height) {
  const baseVideo = width > height ? LANDSCAPE_BASE_VIDEO : PORTRAIT_BASE_VIDEO;
  const scale = Math.min(width / baseVideo.width, height / baseVideo.height);
  const size = Math.max(16, Math.round(baseVideo.watermarkSize * scale));
  const margin = Math.max(8, Math.round(baseVideo.watermarkMargin * scale));
  return {
    x: width - margin - size,
    y: height - margin - size,
    width: size,
    height: size
  };
}

function isPositionInside(imageData, position) {
  return position.x >= 0 &&
    position.y >= 0 &&
    position.x + position.width <= imageData.width &&
    position.y + position.height <= imageData.height;
}

function scoreRegion(imageData, alphaMap, position) {
  const region = {
    x: position.x,
    y: position.y,
    size: position.width
  };
  const spatial = computeRegionSpatialCorrelation({ imageData, alphaMap, region });
  const gradient = computeRegionGradientCorrelation({ imageData, alphaMap, region });
  return {
    spatial,
    gradient,
    score: Math.max(0, spatial) * 0.7 + Math.max(0, gradient) * 0.3
  };
}

function findBestVideoFrameRegion(imageData) {
  const expected = predictedVideoFrameRegion(imageData.width, imageData.height);
  const alphaMap = resolveAlphaMap(expected.width);
  return {
    position: expected,
    alphaMap,
    ...scoreRegion(imageData, alphaMap, expected)
  };
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function resolveInputs(inputPath) {
  const stats = await fs.stat(inputPath);
  if (stats.isFile()) {
    if (!IMAGE_EXTENSIONS.has(path.extname(inputPath).toLowerCase())) {
      throw new Error(`Unsupported image file: ${inputPath}`);
    }
    return [inputPath];
  }
  if (!stats.isDirectory()) throw new Error(`Input is neither file nor directory: ${inputPath}`);

  const entries = await fs.readdir(inputPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(inputPath, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

function outputPathFor(inputPath, inputCount, options) {
  if (options.output) {
    if (inputCount > 1) throw new Error('--output can only be used with one input file.');
    return options.output;
  }

  const parsed = path.parse(inputPath);
  const outputDir = options.outDir ?? path.join(parsed.dir, '去除水印');
  return path.join(outputDir, `${parsed.name}_去水印${parsed.ext || '.png'}`);
}

function safeWorkName(inputPath) {
  const stem = path.parse(inputPath).name
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return stem || 'image';
}

async function runGeminiImagePass(inputPath, outputPath) {
  const { meta } = await removeWatermarkFromFile(inputPath, {
    outputPath,
    mimeType: mimeTypeFor(outputPath),
    decodeImageData,
    encodeImageData
  });

  return meta;
}

async function runVideoFramePass(inputPath, outputPath, options) {
  const imageData = await readImageData(inputPath);
  const detection = findBestVideoFrameRegion(imageData);
  if (!detection || detection.score < FRAME_WATERMARK_MIN_SCORE) {
    return {
      applied: false,
      skipReason: 'no-video-frame-watermark-detected',
      detection: detection
        ? {
          score: detection.score,
          spatial: detection.spatial,
          gradient: detection.gradient,
          position: detection.position
        }
        : null
    };
  }

  removeWatermark(imageData, detection.alphaMap, detection.position, {
    alphaGain: options.frameAlphaGain
  });

  await ensureDir(path.dirname(outputPath));
  const outputBuffer = await encodeRawImageData(imageData, outputPath);
  await fs.writeFile(outputPath, outputBuffer);

  return {
    applied: true,
    engine: 'video-frame',
    alphaGain: options.frameAlphaGain,
    detection: {
      score: detection.score,
      spatial: detection.spatial,
      gradient: detection.gradient,
      position: detection.position
    }
  };
}

async function cleanOneImage(inputPath, outputPath, options) {
  await ensureDir(path.dirname(outputPath));
  const workRoot = path.join(
    '.omni-watermark-work',
    `${safeWorkName(inputPath)}-image-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const geminiOutputPath = path.join(workRoot, `gemini${path.extname(outputPath) || '.png'}`);

  try {
    if (options.mode !== 'video-frame') {
      await ensureDir(workRoot);
      const geminiMeta = await runGeminiImagePass(inputPath, geminiOutputPath);
      if (geminiMeta?.applied || options.mode === 'gemini-image') {
        await fs.copyFile(geminiOutputPath, outputPath);
        return {
          inputPath,
          outputPath,
          engine: 'gemini-image',
          meta: geminiMeta
        };
      }
    }

    const frameMeta = await runVideoFramePass(inputPath, outputPath, options);
    if (frameMeta.applied) {
      return {
        inputPath,
        outputPath,
        engine: 'video-frame',
        meta: frameMeta
      };
    }

    if (options.mode === 'video-frame') {
      await fs.copyFile(inputPath, outputPath);
    } else {
      await fs.copyFile(geminiOutputPath, outputPath);
    }
    return {
      inputPath,
      outputPath,
      engine: 'none',
      meta: frameMeta
    };
  } finally {
    await fs.rm(workRoot, { recursive: true, force: true });
  }
}

async function main() {
  const { input, options } = parseArgs(process.argv.slice(2));
  if (options.help || !input) {
    printHelp();
    return;
  }

  const inputs = await resolveInputs(input);
  if (inputs.length === 0) {
    throw new Error(`No image files found: ${input}`);
  }

  const outputs = [];
  for (const inputPath of inputs) {
    const outputPath = outputPathFor(inputPath, inputs.length, options);
    outputs.push(await cleanOneImage(inputPath, outputPath, options));
  }

  if (options.json) {
    console.log(JSON.stringify(outputs.length === 1 ? outputs[0] : outputs));
    return;
  }

  console.log('\nDone.');
  for (const item of outputs) {
    console.log(`- ${item.outputPath} (${item.engine})`);
  }
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}`);
  process.exitCode = 1;
});
