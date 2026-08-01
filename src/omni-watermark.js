#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';

import { removeWatermark } from '../node_modules/@pilio/gemini-watermark-remover/src/core/blendModes.js';
import { getEmbeddedAlphaMap } from '../node_modules/@pilio/gemini-watermark-remover/src/core/embeddedAlphaMaps.js';
import {
  computeRegionGradientCorrelation,
  computeRegionSpatialCorrelation,
  interpolateAlphaMap
} from '../node_modules/@pilio/gemini-watermark-remover/src/core/adaptiveDetector.js';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm']);
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
const STRATEGIES = new Set(['auto', 'alpha', 'shape-repair', 'hybrid']);
const DEFAULT_GAIN_CANDIDATES = [0.12, 0.16, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65];
const DEFAULT_CRF = 10;
const REMOVELOGO_MASK_THRESHOLD = 0.006;
const REMOVELOGO_MASK_DILATION = 2;
const RESIDUAL_REPAIR_MIN_SCORE = 0.42;
const RESIDUAL_REPAIR_MIN_RESIDUAL = 0.08;
const RESIDUAL_REPAIR_LOW_GAIN = 0.35;
const STABLE_VIDEO_ALPHA_GAIN = 0.6;
const MIN_PREDICTED_WATERMARK_SCORE = 0.12;
const STRICT_MASK_THRESHOLD = 0.002;
const STRICT_MASK_DILATION = 4;
const DETECTION_SAMPLE_TARGET = 5;
const DETECTION_MIN_SUPPORT_RATIO = 0.6;
const DETECTION_MIN_MEDIAN_SCORE = 0.22;
const DETECTION_MIN_AVERAGE_SCORE = 0.24;
const VERIFICATION_SAMPLE_TARGET = 8;
const VERIFICATION_ABSOLUTE_SCORE = 0.24;
const VERIFICATION_RELATIVE_SCORE = 0.14;
const VERIFICATION_MAX_RATIO = 0.62;
const VERIFICATION_AVG_RATIO = 0.7;

const alpha48 = getEmbeddedAlphaMap(48);
const alpha96 = getEmbeddedAlphaMap(96);

function printHelp() {
  console.log(`
Omni visible watermark cleaner

Usage:
  npm run clean:video -- <input-file-or-dir> [options]
  node src/omni-watermark.js <input-file-or-dir> [options]

Options:
  --output <file>          Output path for a single input file.
  --out-dir <dir>          Output directory. Default: <input folder>/去除水印
  --position <x,y,size>    Manual watermark box. Default: auto scan near bottom-right.
  --alpha-gain <value>     Manual reverse-alpha gain. Default: auto
  --strategy <name>        auto | alpha | shape-repair | hybrid. Default: auto
  --crf <number>           H.264 CRF for high-quality output. Default: ${DEFAULT_CRF}
  --lossless               Use x264 lossless mode instead of CRF.
  --jobs <number>          Parallel frame workers. Default: CPU-aware.
  --keep-work              Keep extracted/processed PNG frames for inspection.
  --help                   Show this help.
`);
}

function parseArgs(argv) {
  const options = {
    outDir: null,
    output: null,
    position: null,
    alphaGain: 'auto',
    strategy: 'auto',
    crf: DEFAULT_CRF,
    lossless: false,
    jobs: Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2) || 1)),
    keepWork: false
  };
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--lossless') {
      options.lossless = true;
      continue;
    }
    if (arg === '--keep-work') {
      options.keepWork = true;
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
    if (arg === '--position') {
      options.position = parsePosition(argv[++i]);
      continue;
    }
    if (arg === '--alpha-gain') {
      const raw = argv[++i];
      options.alphaGain = raw === 'auto' ? 'auto' : Number(raw);
      if (options.alphaGain !== 'auto' && !Number.isFinite(options.alphaGain)) {
        throw new Error(`Invalid --alpha-gain: ${raw}`);
      }
      continue;
    }
    if (arg === '--strategy') {
      const raw = String(argv[++i] ?? '').trim();
      if (!STRATEGIES.has(raw)) {
        throw new Error(`--strategy must be one of: ${[...STRATEGIES].join(', ')}`);
      }
      options.strategy = raw;
      continue;
    }
    if (arg === '--crf') {
      options.crf = Number(argv[++i]);
      if (!Number.isFinite(options.crf) || options.crf < 0 || options.crf > 51) {
        throw new Error('--crf must be a number between 0 and 51.');
      }
      continue;
    }
    if (arg === '--jobs') {
      options.jobs = Math.max(1, Number(argv[++i]));
      if (!Number.isFinite(options.jobs)) {
        throw new Error('--jobs must be a positive number.');
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

function parsePosition(value) {
  const parts = String(value ?? '').split(',').map((item) => Number(item.trim()));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error('--position must use the format x,y,size.');
  }
  const [x, y, size] = parts.map((part) => Math.round(part));
  if (size <= 0) throw new Error('--position size must be positive.');
  return { x, y, width: size, height: size };
}

function run(command, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    });
    let stdout = '';
    let stderr = '';

    if (capture) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
    }

    child.on('error', (error) => {
      reject(new Error(`${command} failed to start: ${error.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} exited with code ${code}${stderr ? `\n${stderr}` : ''}`));
    });
  });
}

async function assertCommand(command) {
  try {
    await run(command, ['-version'], { capture: true });
  } catch {
    throw new Error(`Missing required command: ${command}`);
  }
}

async function probeVideo(inputPath) {
  const { stderr } = await run('ffmpeg', [
    '-hide_banner',
    '-i',
    inputPath,
    '-map',
    '0:v:0',
    '-frames:v',
    '1',
    '-f',
    'null',
    '-'
  ], { capture: true });
  const inputSection = stderr.split('Stream mapping:')[0];
  const videoLine = inputSection
    .split('\n')
    .find((line) => /Stream #.*Video:/.test(line));
  if (!videoLine) throw new Error(`No video stream found: ${inputPath}`);

  const dimensions = videoLine.match(/(?:^|,\s)(\d{2,5})x(\d{2,5})(?:[\s,]|$)/);
  if (!dimensions) throw new Error(`Unable to read video dimensions: ${inputPath}`);

  const fpsMatch = videoLine.match(/(\d+(?:\.\d+)?)\s+fps\b/) ??
    videoLine.match(/(\d+(?:\.\d+)?)\s+tbr\b/);
  const durationMatch = inputSection.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = durationMatch
    ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    : 0;

  return {
    width: Number(dimensions[1]),
    height: Number(dimensions[2]),
    fps: fpsMatch ? String(Number(fpsMatch[1])) : '24',
    hasAudio: /Stream #.*Audio:/.test(inputSection),
    duration,
    frames: 0
  };
}

function normalizeFps(value) {
  if (!value || value === '0/0') return '24';
  const [num, den] = String(value).split('/').map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return '24';
  if (den === 1) return String(num);
  return Number(num / den).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function fpsToNumber(value) {
  const fps = Number(value);
  return Number.isFinite(fps) && fps > 0 ? fps : 24;
}

function formatSeconds(value) {
  return Number(value).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function expectedFrameCount(info) {
  if (!Number.isFinite(info.duration) || info.duration <= 0) return null;
  return Math.max(1, Math.round(info.duration * fpsToNumber(info.fps)));
}

async function resolveInputs(inputPath) {
  const stats = await fs.stat(inputPath);
  if (stats.isFile()) return [inputPath];
  if (!stats.isDirectory()) throw new Error(`Input is neither file nor directory: ${inputPath}`);

  const entries = await fs.readdir(inputPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(inputPath, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function extractFrames(inputPath, framesDir, fps) {
  await ensureDir(framesDir);
  await run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inputPath,
    '-map',
    '0:v:0',
    '-vf',
    `fps=${fpsToNumber(fps)}`,
    path.join(framesDir, 'frame_%06d.png')
  ]);
}

async function readFrameImageData(framePath) {
  const { data, info } = await sharp(framePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data)
  };
}

async function writeFrameImageData(imageData, framePath) {
  await sharp(Buffer.from(imageData.data), {
    raw: {
      width: imageData.width,
      height: imageData.height,
      channels: 4
    }
  })
    .png({ compressionLevel: 4 })
    .toFile(framePath);
}

function resolveAlphaMap(size) {
  if (size === 48) return new Float32Array(alpha48);
  if (size === 96) return new Float32Array(alpha96);
  if (size <= 64) return interpolateAlphaMap(alpha48, 48, size);
  return interpolateAlphaMap(alpha96, 96, size);
}

function predictedRegion(width, height) {
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

function findBestRegionInFrame(imageData, forcedPosition = null) {
  if (forcedPosition) {
    const alphaMap = resolveAlphaMap(forcedPosition.width);
    return {
      position: forcedPosition,
      alphaMap,
      ...scoreRegion(imageData, alphaMap, forcedPosition),
      source: 'manual'
    };
  }

  const expected = predictedRegion(imageData.width, imageData.height);
  const expectedAlphaMap = resolveAlphaMap(expected.width);
  const expectedScore = scoreRegion(imageData, expectedAlphaMap, expected);
  const expectedCandidate = {
    position: expected,
    alphaMap: expectedAlphaMap,
    ...expectedScore,
    source: 'predicted'
  };

  const centerX = expected.x + expected.width / 2;
  const centerY = expected.y + expected.height / 2;
  const baseVideo = imageData.width > imageData.height ? LANDSCAPE_BASE_VIDEO : PORTRAIT_BASE_VIDEO;
  const scale = expected.width / baseVideo.watermarkSize;
  const sizeOffsets = [-12, -10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10, 12]
    .map((offset) => Math.round(offset * scale));
  const shiftWindow = Math.max(16, Math.round(32 * scale));
  const shiftStep = Math.max(1, Math.round(2 * scale));

  let best = null;
  for (const offset of sizeOffsets) {
    const size = Math.max(16, expected.width + offset);
    const alphaMap = resolveAlphaMap(size);
    for (let dy = -shiftWindow; dy <= shiftWindow; dy += shiftStep) {
      for (let dx = -shiftWindow; dx <= shiftWindow; dx += shiftStep) {
        const position = {
          x: Math.round(centerX - size / 2 + dx),
          y: Math.round(centerY - size / 2 + dy),
          width: size,
          height: size
        };
        if (!isPositionInside(imageData, position)) continue;

        const scored = scoreRegion(imageData, alphaMap, position);
        if (!best || scored.score > best.score) {
          best = { position, alphaMap, ...scored, source: 'scan' };
        }
      }
    }
  }

  if (!best || best.score < 0.2) {
    if (expectedCandidate.score < MIN_PREDICTED_WATERMARK_SCORE) {
      return {
        ...expectedCandidate,
        source: 'uncertain',
        skipRemoval: true,
        skipReason: 'low-confidence-watermark-location'
      };
    }
    return expectedCandidate;
  }

  if (shouldPreferPredictedRegion(expectedCandidate, best)) {
    return {
      ...expectedCandidate,
      source: 'predicted-stable'
    };
  }

  return best;
}

function shouldPreferPredictedRegion(expectedCandidate, scanCandidate) {
  if (!scanCandidate || expectedCandidate.score < 0.24) return false;

  const expected = expectedCandidate.position;
  const scan = scanCandidate.position;
  const expectedCenterX = expected.x + expected.width / 2;
  const expectedCenterY = expected.y + expected.height / 2;
  const scanCenterX = scan.x + scan.width / 2;
  const scanCenterY = scan.y + scan.height / 2;
  const normalizedDistance = Math.hypot(
    scanCenterX - expectedCenterX,
    scanCenterY - expectedCenterY
  ) / expected.width;
  const sizeDelta = Math.abs(scan.width - expected.width) / expected.width;
  const scanAdvantage = scanCandidate.score - expectedCandidate.score;

  return (normalizedDistance > 0.32 || sizeDelta > 0.18) && scanAdvantage < 0.18;
}

function isPositionInside(imageData, position) {
  return position.x >= 0 &&
    position.y >= 0 &&
    position.x + position.width <= imageData.width &&
    position.y + position.height <= imageData.height;
}

function cloneImageData(imageData) {
  return {
    width: imageData.width,
    height: imageData.height,
    data: new Uint8ClampedArray(imageData.data)
  };
}

function regionLuminanceStats(imageData, position) {
  let min = 255;
  let max = 0;
  let sum = 0;
  let nearBlackCount = 0;
  let clippedCount = 0;
  let highlightCount = 0;
  let gradientSum = 0;
  let gradientCount = 0;
  let pixelCount = 0;

  for (let row = 0; row < position.height; row += 1) {
    for (let col = 0; col < position.width; col += 1) {
      const idx = ((position.y + row) * imageData.width + position.x + col) * 4;
      const lum = 0.2126 * imageData.data[idx] +
        0.7152 * imageData.data[idx + 1] +
        0.0722 * imageData.data[idx + 2];
      min = Math.min(min, lum);
      max = Math.max(max, lum);
      sum += lum;
      pixelCount += 1;

      if (lum < 8) nearBlackCount += 1;
      if (
        imageData.data[idx] <= 2 ||
        imageData.data[idx + 1] <= 2 ||
        imageData.data[idx + 2] <= 2
      ) {
        clippedCount += 1;
      }
      if (lum > 225) highlightCount += 1;

      if (col > 0) {
        const leftIdx = ((position.y + row) * imageData.width + position.x + col - 1) * 4;
        const leftLum = 0.2126 * imageData.data[leftIdx] +
          0.7152 * imageData.data[leftIdx + 1] +
          0.0722 * imageData.data[leftIdx + 2];
        gradientSum += Math.abs(lum - leftLum);
        gradientCount += 1;
      }
      if (row > 0) {
        const topIdx = ((position.y + row - 1) * imageData.width + position.x + col) * 4;
        const topLum = 0.2126 * imageData.data[topIdx] +
          0.7152 * imageData.data[topIdx + 1] +
          0.0722 * imageData.data[topIdx + 2];
        gradientSum += Math.abs(lum - topLum);
        gradientCount += 1;
      }
    }
  }

  return {
    min,
    max,
    mean: pixelCount > 0 ? sum / pixelCount : 0,
    nearBlackRatio: pixelCount > 0 ? nearBlackCount / pixelCount : 0,
    clippedRatio: pixelCount > 0 ? clippedCount / pixelCount : 0,
    highlightRatio: pixelCount > 0 ? highlightCount / pixelCount : 0,
    edgeEnergy: gradientCount > 0 ? gradientSum / gradientCount : 0
  };
}

function frameLuminanceStats(imageData) {
  let sum = 0;
  let nearBlackCount = 0;
  let highlightCount = 0;
  const pixelCount = imageData.width * imageData.height;

  for (let index = 0; index < imageData.data.length; index += 4) {
    const lum = 0.2126 * imageData.data[index] +
      0.7152 * imageData.data[index + 1] +
      0.0722 * imageData.data[index + 2];
    sum += lum;
    if (lum < 18) nearBlackCount += 1;
    if (lum > 225) highlightCount += 1;
  }

  return {
    mean: pixelCount > 0 ? sum / pixelCount : 0,
    nearBlackRatio: pixelCount > 0 ? nearBlackCount / pixelCount : 0,
    highlightRatio: pixelCount > 0 ? highlightCount / pixelCount : 0
  };
}

function alphaRemovalCost(sample, alphaMap, position, gain, originalStats) {
  const candidate = cloneImageData(sample);
  removeWatermark(candidate, alphaMap, position, { alphaGain: gain });
  const residual = scoreRegion(candidate, alphaMap, position);
  const candidateStats = regionLuminanceStats(candidate, position);
  const minDrop = originalStats.min - candidateStats.min;
  const meanDrop = originalStats.mean - candidateStats.mean;
  const nearBlackIncrease = candidateStats.nearBlackRatio - originalStats.nearBlackRatio;
  const clippedIncrease = candidateStats.clippedRatio - originalStats.clippedRatio;
  // 近黑和通道裁剪通常说明 alpha 增益过大，正在把水印扣成黑色残影。
  const darkPenalty =
    Math.max(0, minDrop - 18) / 55 +
    Math.max(0, meanDrop - 8) / 35 +
    Math.max(0, nearBlackIncrease - 0.01) * 8 +
    Math.max(0, clippedIncrease - 0.02) * 6;

  return {
    residual,
    candidateStats,
    minDrop,
    meanDrop,
    nearBlackIncrease,
    clippedIncrease,
    darkPenalty,
    cost: Math.abs(residual.spatial) +
      Math.max(0, residual.gradient) * 0.2 +
      darkPenalty
  };
}

function chooseAlphaGain(sampleImageData, alphaMap, position, forcedAlphaGain) {
  if (forcedAlphaGain !== 'auto') {
    return {
      gain: forcedAlphaGain,
      cost: 0,
      forced: true,
      candidateIndex: -1,
      atLowerBound: false,
      atUpperBound: false
    };
  }

  const samples = Array.isArray(sampleImageData) ? sampleImageData : [sampleImageData];
  const originals = samples.map((sample) => regionLuminanceStats(sample, position));
  let best = null;

  for (const gain of DEFAULT_GAIN_CANDIDATES) {
    let totalCost = 0;

    for (let index = 0; index < samples.length; index += 1) {
      totalCost += alphaRemovalCost(samples[index], alphaMap, position, gain, originals[index]).cost;
    }

    const cost = totalCost / samples.length;

    if (!best || cost < best.cost) {
      best = {
        gain,
        cost,
        forced: false,
        candidateIndex: DEFAULT_GAIN_CANDIDATES.indexOf(gain),
        atLowerBound: gain === DEFAULT_GAIN_CANDIDATES[0],
        atUpperBound: gain === DEFAULT_GAIN_CANDIDATES[DEFAULT_GAIN_CANDIDATES.length - 1]
      };
    }
  }

  return best ?? {
    gain: 0.25,
    cost: 0,
    forced: false,
    candidateIndex: -1,
    atLowerBound: false,
    atUpperBound: false
  };
}

function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function evaluateAlphaRemoval(samples, alphaMap, position, alphaGain) {
  const originalScores = [];
  const residualScores = [];
  const residualSpatials = [];
  const residualGradients = [];
  const meanDrops = [];
  const minDrops = [];
  const nearBlackIncreases = [];
  const clippedIncreases = [];
  const highlightRatios = [];
  const edgeEnergies = [];
  const darkPenalties = [];

  for (const sample of samples) {
    const originalStats = regionLuminanceStats(sample, position);
    const cost = alphaRemovalCost(sample, alphaMap, position, alphaGain, originalStats);
    const originalScore = scoreRegion(sample, alphaMap, position);

    originalScores.push(originalScore.score);
    residualScores.push(cost.residual.score);
    residualSpatials.push(cost.residual.spatial);
    residualGradients.push(cost.residual.gradient);
    meanDrops.push(cost.meanDrop);
    minDrops.push(cost.minDrop);
    nearBlackIncreases.push(cost.nearBlackIncrease);
    clippedIncreases.push(cost.clippedIncrease);
    highlightRatios.push(originalStats.highlightRatio);
    edgeEnergies.push(originalStats.edgeEnergy);
    darkPenalties.push(cost.darkPenalty);
  }

  const avgOriginalScore = average(originalScores);
  const avgResidualScore = average(residualScores);

  return {
    avgOriginalScore,
    avgResidualScore,
    residualRatio: avgOriginalScore > 0 ? avgResidualScore / avgOriginalScore : 0,
    avgResidualSpatial: average(residualSpatials),
    avgResidualGradient: average(residualGradients),
    avgMeanDrop: average(meanDrops),
    maxMeanDrop: Math.max(0, ...meanDrops),
    avgMinDrop: average(minDrops),
    maxMinDrop: Math.max(0, ...minDrops),
    maxNearBlackIncrease: Math.max(0, ...nearBlackIncreases),
    maxClippedIncrease: Math.max(0, ...clippedIncreases),
    avgHighlightRatio: average(highlightRatios),
    avgEdgeEnergy: average(edgeEnergies),
    avgDarkPenalty: average(darkPenalties)
  };
}

function maybePreferStableVideoGain(samples, alphaMap, position, gainChoice, detectionSource) {
  if (gainChoice.forced || gainChoice.gain >= 0.55 || detectionSource !== 'predicted-stable') {
    return gainChoice;
  }

  const currentDiagnostics = evaluateAlphaRemoval(samples, alphaMap, position, gainChoice.gain);
  const stableDiagnostics = evaluateAlphaRemoval(samples, alphaMap, position, STABLE_VIDEO_ALPHA_GAIN);
  const residualImproved =
    stableDiagnostics.avgResidualScore + 0.04 < currentDiagnostics.avgResidualScore ||
    stableDiagnostics.residualRatio < currentDiagnostics.residualRatio * 0.68;
  const veryCleanResidual =
    stableDiagnostics.avgResidualScore < 0.04 &&
    stableDiagnostics.residualRatio < 0.45;
  const darkeningRisk =
    stableDiagnostics.maxNearBlackIncrease > 0.018 ||
    stableDiagnostics.maxClippedIncrease > 0.035 ||
    stableDiagnostics.maxMinDrop > 32 ||
    stableDiagnostics.maxMeanDrop > 16 ||
    stableDiagnostics.avgDarkPenalty > 0.42;

  if (!residualImproved || (darkeningRisk && !veryCleanResidual)) return gainChoice;

  return {
    ...gainChoice,
    gain: STABLE_VIDEO_ALPHA_GAIN,
    stableOverride: true
  };
}

function selectStrategy({ requestedStrategy, gainChoice, diagnostics, detectionScore, frameStats }) {
  if (requestedStrategy !== 'auto') return requestedStrategy;

  const strongResidual = diagnostics.avgResidualScore > 0.32 && diagnostics.residualRatio > 0.35;
  const riskyDarkening =
    diagnostics.maxNearBlackIncrease > 0.018 ||
    diagnostics.maxClippedIncrease > 0.035 ||
    diagnostics.maxMinDrop > 28 ||
    diagnostics.maxMeanDrop > 14 ||
    diagnostics.avgDarkPenalty > 0.34;
  const forcedLowGain = !gainChoice.forced && gainChoice.gain <= 0.4;
  const reflectiveOrTextured =
    diagnostics.avgHighlightRatio > 0.08 ||
    diagnostics.avgEdgeEnergy > 9;
  const brightFlatScene =
    (frameStats?.mean ?? 0) > 110 &&
    diagnostics.avgEdgeEnergy < 10 &&
    diagnostics.avgResidualScore > 0.1 &&
    gainChoice.gain >= 0.55;
  const persistentLowGainResidual =
    detectionScore >= RESIDUAL_REPAIR_MIN_SCORE &&
    diagnostics.avgResidualScore >= 0.1 &&
    forcedLowGain;

  if (
    persistentLowGainResidual ||
    (detectionScore > 0.55 && (brightFlatScene || (strongResidual && forcedLowGain && reflectiveOrTextured)))
  ) {
    return 'shape-repair';
  }

  if (detectionScore > 0.5 && strongResidual && (riskyDarkening || gainChoice.gain <= 0.45 || reflectiveOrTextured)) {
    return 'hybrid';
  }

  return 'alpha';
}

function shouldRepairResidual(plan) {
  const visibleResidual =
    plan.detection.score >= RESIDUAL_REPAIR_MIN_SCORE &&
    plan.diagnostics.avgResidualScore >= RESIDUAL_REPAIR_MIN_RESIDUAL;
  const lowGainResidual = plan.alphaGain <= RESIDUAL_REPAIR_LOW_GAIN;
  const stableResidualShape =
    plan.diagnostics.residualRatio > 0.22 ||
    plan.diagnostics.avgResidualSpatial > 0.16 ||
    plan.diagnostics.avgResidualGradient > 0.12;

  return visibleResidual && (lowGainResidual || stableResidualShape);
}

function applyAlphaPass(imageData, plan) {
  removeWatermark(imageData, plan.alphaMap, plan.position, { alphaGain: plan.alphaGain });
}

function dilateMask(mask, width, height, iterations) {
  let current = mask;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = new Uint8ClampedArray(current);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (current[y * width + x] === 0) continue;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            next[ny * width + nx] = 255;
          }
        }
      }
    }
    current = next;
  }

  return current;
}

async function writeRemoveLogoMask(maskPath, plan, width, height, maskOptions = {}) {
  const threshold = maskOptions.threshold ?? REMOVELOGO_MASK_THRESHOLD;
  const dilation = maskOptions.dilation ?? REMOVELOGO_MASK_DILATION;
  let mask = new Uint8ClampedArray(width * height);

  for (let row = 0; row < plan.position.height; row += 1) {
    for (let col = 0; col < plan.position.width; col += 1) {
      const alpha = plan.alphaMap[row * plan.position.width + col] ?? 0;
      if (alpha < threshold) continue;

      const x = plan.position.x + col;
      const y = plan.position.y + row;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      mask[y * width + x] = 255;
    }
  }

  mask = dilateMask(mask, width, height, dilation);

  const rgb = Buffer.alloc(width * height * 3);
  for (let index = 0; index < mask.length; index += 1) {
    const value = mask[index];
    rgb[index * 3] = value;
    rgb[index * 3 + 1] = value;
    rgb[index * 3 + 2] = value;
  }

  await sharp(rgb, {
    raw: {
      width,
      height,
      channels: 3
    }
  })
    .png({ compressionLevel: 9 })
    .toFile(maskPath);
}

function escapeFilterValue(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/ /g, '\\ ');
}

function videoEncodeArgs(options) {
  return options.lossless
    ? ['-c:v', 'libx264', '-preset', 'medium', '-crf', '0']
    : ['-c:v', 'libx264', '-preset', 'slow', '-crf', String(options.crf)];
}

function selectSamplePaths(framePaths, target = DETECTION_SAMPLE_TARGET) {
  if (framePaths.length <= target) return framePaths;
  const indices = new Set();
  for (let index = 0; index < target; index += 1) {
    indices.add(Math.round((framePaths.length - 1) * index / (target - 1)));
  }
  return [...indices].sort((a, b) => a - b).map((index) => framePaths[index]);
}

async function detectPlan(framePaths, options) {
  const samplePaths = selectSamplePaths(framePaths, DETECTION_SAMPLE_TARGET);
  let best = null;
  let bestImageData = null;
  const sampleImageData = [];

  for (const samplePath of samplePaths) {
    const imageData = await readFrameImageData(samplePath);
    sampleImageData.push(imageData);
    const candidate = findBestRegionInFrame(imageData, options.position);
    if (!best || candidate.score > best.score) {
      best = candidate;
      bestImageData = imageData;
    }
  }

  const persistentScores = sampleImageData.map((imageData) => {
    const evidence = scoreRegion(imageData, best.alphaMap, best.position);
    return evidence.score;
  });
  const supportThreshold = Math.max(
    DETECTION_MIN_MEDIAN_SCORE,
    best.score * 0.45
  );
  const supportCount = persistentScores.filter((score) => score >= supportThreshold).length;
  const persistence = {
    sampleCount: persistentScores.length,
    supportCount,
    supportRatio: persistentScores.length > 0 ? supportCount / persistentScores.length : 0,
    supportThreshold,
    averageScore: average(persistentScores),
    medianScore: median(persistentScores),
    minScore: Math.min(...persistentScores),
    maxScore: Math.max(...persistentScores)
  };
  const persistentDetection =
    persistence.supportRatio >= DETECTION_MIN_SUPPORT_RATIO &&
    persistence.medianScore >= DETECTION_MIN_MEDIAN_SCORE &&
    persistence.averageScore >= DETECTION_MIN_AVERAGE_SCORE;

  const gainSamples = sampleImageData.length > 0 ? sampleImageData : bestImageData;
  const normalizedGainSamples = Array.isArray(gainSamples) ? gainSamples : [gainSamples];
  let gainChoice = chooseAlphaGain(normalizedGainSamples, best.alphaMap, best.position, options.alphaGain);
  gainChoice = maybePreferStableVideoGain(
    normalizedGainSamples,
    best.alphaMap,
    best.position,
    gainChoice,
    best.source
  );
  const diagnostics = evaluateAlphaRemoval(normalizedGainSamples, best.alphaMap, best.position, gainChoice.gain);
  const frameStats = normalizedGainSamples.length > 0 ? frameLuminanceStats(normalizedGainSamples[0]) : null;
  const strategy = selectStrategy({
    requestedStrategy: options.strategy,
    gainChoice,
    diagnostics,
    detectionScore: best.score,
    frameStats
  });

  return {
    position: best.position,
    alphaMap: best.alphaMap,
    alphaGain: gainChoice.gain,
    gainChoice,
    strategy,
    diagnostics,
    skipRemoval: Boolean(best.skipRemoval) || !persistentDetection,
    skipReason: best.skipReason ?? (!persistentDetection ? 'unstable-watermark-evidence' : null),
    detection: {
      source: best.source,
      score: best.score,
      spatial: best.spatial,
      gradient: best.gradient,
      persistence
    }
  };
}

async function measureWatermarkEvidence(framePaths, plan) {
  const samplePaths = selectSamplePaths(framePaths, VERIFICATION_SAMPLE_TARGET);
  const scores = [];
  const spatials = [];
  const gradients = [];

  for (const samplePath of samplePaths) {
    const imageData = await readFrameImageData(samplePath);
    const evidence = scoreRegion(imageData, plan.alphaMap, plan.position);
    const spatial = Math.abs(evidence.spatial);
    const gradient = Math.abs(evidence.gradient);
    scores.push(spatial * 0.7 + gradient * 0.3);
    spatials.push(spatial);
    gradients.push(gradient);
  }

  return {
    sampleCount: samplePaths.length,
    avgScore: average(scores),
    maxScore: Math.max(0, ...scores),
    avgSpatial: average(spatials),
    maxSpatial: Math.max(0, ...spatials),
    avgGradient: average(gradients),
    maxGradient: Math.max(0, ...gradients)
  };
}

function residualVerification(sourceEvidence, outputEvidence) {
  const sourceMax = Math.max(sourceEvidence.maxScore, 0.001);
  const sourceAvg = Math.max(sourceEvidence.avgScore, 0.001);
  const maxRatio = outputEvidence.maxScore / sourceMax;
  const avgRatio = outputEvidence.avgScore / sourceAvg;
  const strongAbsoluteResidual =
    outputEvidence.maxScore >= VERIFICATION_ABSOLUTE_SCORE &&
    outputEvidence.avgScore >= VERIFICATION_RELATIVE_SCORE;
  const persistentRelativeResidual =
    sourceEvidence.maxScore >= MIN_PREDICTED_WATERMARK_SCORE &&
    outputEvidence.maxScore >= VERIFICATION_RELATIVE_SCORE &&
    maxRatio >= VERIFICATION_MAX_RATIO &&
    avgRatio >= VERIFICATION_AVG_RATIO;

  return {
    passed: !(strongAbsoluteResidual || persistentRelativeResidual),
    maxRatio,
    avgRatio,
    strongAbsoluteResidual,
    persistentRelativeResidual
  };
}

async function extractVerificationFrames(videoPath, framesDir, duration) {
  await ensureDir(framesDir);
  const rate = Number.isFinite(duration) && duration > 0
    ? Math.max(0.05, Math.min(1, VERIFICATION_SAMPLE_TARGET / duration))
    : 1;

  await run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    videoPath,
    '-map',
    '0:v:0',
    '-vf',
    `fps=${formatSeconds(rate)}`,
    path.join(framesDir, 'verify_%03d.png')
  ]);

  return (await listFramePaths(framesDir)).framePaths;
}

async function verifyRenderedOutput({ outputPath, verifyDir, duration, plan, sourceEvidence }) {
  const framePaths = await extractVerificationFrames(outputPath, verifyDir, duration);
  const outputEvidence = await measureWatermarkEvidence(framePaths, plan);
  const verdict = residualVerification(sourceEvidence, outputEvidence);
  console.log(
    `  verification: ${verdict.passed ? 'pass' : 'residual'}, ` +
    `sourceMax=${sourceEvidence.maxScore.toFixed(3)}, ` +
    `outputMax=${outputEvidence.maxScore.toFixed(3)}, ` +
    `maxRatio=${verdict.maxRatio.toFixed(3)}, ` +
    `avgRatio=${verdict.avgRatio.toFixed(3)}`
  );
  return { framePaths, outputEvidence, verdict };
}

async function listFramePaths(framesDir) {
  const frameNames = (await fs.readdir(framesDir))
    .filter((name) => name.endsWith('.png'))
    .sort((a, b) => a.localeCompare(b));
  const framePaths = frameNames.map((name) => path.join(framesDir, name));
  if (framePaths.length === 0) throw new Error(`No extracted frames found in ${framesDir}`);
  return { frameNames, framePaths };
}

function frameNameForIndex(index) {
  return `frame_${String(index).padStart(6, '0')}.png`;
}

async function normalizeFrameCoverage(framesDir, expectedCount) {
  if (!expectedCount) return listFramePaths(framesDir);

  let { frameNames } = await listFramePaths(framesDir);
  const originalCount = frameNames.length;

  if (frameNames.length < expectedCount) {
    const lastFramePath = path.join(framesDir, frameNames[frameNames.length - 1]);
    for (let index = frameNames.length + 1; index <= expectedCount; index += 1) {
      await fs.copyFile(lastFramePath, path.join(framesDir, frameNameForIndex(index)));
    }
  } else if (frameNames.length > expectedCount) {
    const extraNames = frameNames.slice(expectedCount);
    await Promise.all(extraNames.map((name) => fs.rm(path.join(framesDir, name), { force: true })));
  }

  if (originalCount !== expectedCount) {
    console.log(`  normalized frame count: ${originalCount} -> ${expectedCount}`);
  }

  return listFramePaths(framesDir);
}

async function mapLimit(items, limit, worker) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function processFrames(framesDir, processedDir, options, plan) {
  await ensureDir(processedDir);
  const { frameNames, framePaths } = await listFramePaths(framesDir);
  const progressInterval = Math.max(1, Math.floor(framePaths.length / 10));

  await mapLimit(frameNames, options.jobs, async (frameName, index) => {
    const inputFrame = path.join(framesDir, frameName);
    const outputFrame = path.join(processedDir, frameName);
    const imageData = await readFrameImageData(inputFrame);
    applyAlphaPass(imageData, plan);
    await writeFrameImageData(imageData, outputFrame);

    if ((index + 1) % progressInterval === 0 || index + 1 === frameNames.length) {
      process.stdout.write(`\r  processed ${index + 1}/${frameNames.length} frames`);
    }
  });
  process.stdout.write('\n');

  return {
    frameCount: framePaths.length,
    plan
  };
}

async function renderVideo({ processedDir, inputPath, outputPath, fps, duration, options }) {
  await ensureDir(path.dirname(outputPath));

  await run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-framerate',
    fps,
    '-i',
    path.join(processedDir, 'frame_%06d.png'),
    '-i',
    inputPath,
    '-map',
    '0:v:0',
    '-map',
    '1:a?',
    ...videoEncodeArgs(options),
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'copy',
    ...(Number.isFinite(duration) && duration > 0 ? ['-t', formatSeconds(duration)] : []),
    '-movflags',
    '+faststart',
    outputPath
  ]);
}

async function validateOutputDuration(inputInfo, outputPath) {
  if (!Number.isFinite(inputInfo.duration) || inputInfo.duration <= 0) return;

  const outputInfo = await probeVideo(outputPath);
  if (outputInfo.duration + 0.25 < inputInfo.duration) {
    throw new Error(
      `输出视频时长异常: ${formatSeconds(outputInfo.duration)}s，源视频 ${formatSeconds(inputInfo.duration)}s`
    );
  }
}

async function renderRemoveLogoVideo({ inputPath, outputPath, maskPath, options }) {
  await ensureDir(path.dirname(outputPath));

  await run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inputPath,
    '-vf',
    `removelogo=f=${escapeFilterValue(maskPath)}`,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    ...videoEncodeArgs(options),
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'copy',
    '-movflags',
    '+faststart',
    outputPath
  ]);
}

function outputPathFor(inputPath, inputCount, options) {
  if (options.output) {
    if (inputCount > 1) throw new Error('--output can only be used with one input file.');
    return options.output;
  }

  const parsed = path.parse(inputPath);
  const outputDir = options.outDir ?? path.join(parsed.dir, '去除水印');
  return path.join(outputDir, `${parsed.name}_去水印.mp4`);
}

function safeWorkName(inputPath) {
  const stem = path.parse(inputPath).name
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return stem || 'video';
}

async function cleanOneVideo(inputPath, outputPath, options) {
  const info = await probeVideo(inputPath);
  const workRoot = path.join(
    '.omni-watermark-work',
    `${safeWorkName(inputPath)}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const framesDir = path.join(workRoot, 'frames');
  const processedDir = path.join(workRoot, 'processed');
  const maskPath = path.join(workRoot, 'removelogo-mask.png');
  const strictMaskPath = path.join(workRoot, 'removelogo-mask-strict.png');
  const alphaPassPath = path.join(workRoot, 'alpha-pass.mp4');
  const candidatePath = path.join(workRoot, 'candidate-output.mp4');
  const strictCandidatePath = path.join(workRoot, 'candidate-output-strict.mp4');
  const verifyDir = path.join(workRoot, 'verify-output');
  const strictVerifyDir = path.join(workRoot, 'verify-output-strict');

  console.log(`\n▶ ${inputPath}`);
  console.log(`  ${info.width}x${info.height}, fps ${info.fps}, audio ${info.hasAudio ? 'yes' : 'no'}`);

  try {
    console.log('  extracting frames...');
    await extractFrames(inputPath, framesDir, info.fps);
    const expectedFrames = expectedFrameCount(info);
    const { framePaths } = await normalizeFrameCoverage(framesDir, expectedFrames);

    console.log('  detecting visible watermark...');
    const detectedPlan = await detectPlan(framePaths, options);
    if (detectedPlan.skipRemoval) {
      const persistence = detectedPlan.detection.persistence;
      console.log(
        `  detection rejected: reason=${detectedPlan.skipReason}, ` +
        `score=${detectedPlan.detection.score.toFixed(3)}, ` +
        `support=${persistence.supportCount}/${persistence.sampleCount}, ` +
        `median=${persistence.medianScore.toFixed(3)}, ` +
        `average=${persistence.averageScore.toFixed(3)}`
      );
      throw new Error(
        '无法可靠定位 Omni 水印，已阻止输出，避免误修复或把原视频标记为成功。' +
        '请确认文件是包含右下角 Omni 星形水印的原始视频后重试。'
      );
    }
    const plan = detectedPlan;
    const pos = plan.position;
    console.log(
      `  plan: ${plan.detection.source}, box=${pos.x},${pos.y},${pos.width}, ` +
      `strategy=${plan.strategy}, alphaGain=${plan.alphaGain}, ` +
      `score=${plan.detection.score.toFixed(3)}, ` +
      `support=${plan.detection.persistence.supportCount}/${plan.detection.persistence.sampleCount}, ` +
      `median=${plan.detection.persistence.medianScore.toFixed(3)}, ` +
      `residual=${plan.diagnostics.avgResidualScore.toFixed(3)}`
    );

    const sourceEvidence = await measureWatermarkEvidence(framePaths, plan);

    if (plan.strategy === 'alpha') {
      console.log('  applying reverse-alpha pass...');
      await processFrames(framesDir, processedDir, options, plan);

      const residualPlan = await detectPlan((await listFramePaths(processedDir)).framePaths, options);
      if (options.strategy === 'auto' && shouldRepairResidual(residualPlan)) {
        const residualPos = residualPlan.position;
        console.log(
          `  residual watermark detected, box=${residualPos.x},${residualPos.y},${residualPos.width}, ` +
          `score=${residualPlan.detection.score.toFixed(3)}, ` +
          `residual=${residualPlan.diagnostics.avgResidualScore.toFixed(3)}`
        );

        console.log('  rendering alpha pass...');
        await renderVideo({
          processedDir,
          inputPath,
          outputPath: alphaPassPath,
          fps: info.fps,
          duration: info.duration,
          options
        });

        console.log('  applying residual shape-mask repair...');
        await writeRemoveLogoMask(maskPath, residualPlan, info.width, info.height);
        await renderRemoveLogoVideo({
          inputPath: alphaPassPath,
          outputPath: candidatePath,
          maskPath,
          options
        });
      } else {
        console.log('  rendering output...');
        await renderVideo({
          processedDir,
          inputPath,
          outputPath: candidatePath,
          fps: info.fps,
          duration: info.duration,
          options
        });
      }
    } else if (plan.strategy === 'shape-repair') {
      console.log('  applying shape-mask repair...');
      await writeRemoveLogoMask(
        maskPath,
        plan,
        info.width,
        info.height
      );
      await renderRemoveLogoVideo({
        inputPath,
        outputPath: candidatePath,
        maskPath,
        options
      });
    } else {
      console.log('  applying reverse-alpha pass...');
      await processFrames(framesDir, processedDir, options, plan);
      await renderVideo({
        processedDir,
        inputPath,
        outputPath: alphaPassPath,
        fps: info.fps,
        duration: info.duration,
        options
      });

      console.log('  applying shape-mask repair...');
      await writeRemoveLogoMask(maskPath, plan, info.width, info.height);
      await renderRemoveLogoVideo({
        inputPath: alphaPassPath,
        outputPath: candidatePath,
        maskPath,
        options
      });
    }

    await validateOutputDuration(info, candidatePath);
    let verifiedCandidatePath = candidatePath;
    const firstVerification = await verifyRenderedOutput({
      outputPath: candidatePath,
      verifyDir,
      duration: info.duration,
      plan,
      sourceEvidence
    });

    if (!firstVerification.verdict.passed) {
      console.log('  residual evidence remains; applying strict second-pass shape repair...');
      await writeRemoveLogoMask(strictMaskPath, plan, info.width, info.height, {
        threshold: STRICT_MASK_THRESHOLD,
        dilation: STRICT_MASK_DILATION
      });
      await renderRemoveLogoVideo({
        inputPath: candidatePath,
        outputPath: strictCandidatePath,
        maskPath: strictMaskPath,
        options
      });
      await validateOutputDuration(info, strictCandidatePath);
      const strictVerification = await verifyRenderedOutput({
        outputPath: strictCandidatePath,
        verifyDir: strictVerifyDir,
        duration: info.duration,
        plan,
        sourceEvidence
      });

      if (!strictVerification.verdict.passed) {
        throw new Error(
          '成品复检仍检测到明显水印残留，已阻止输出。请重试；多次失败时请更换原始素材。'
        );
      }

      verifiedCandidatePath = strictCandidatePath;
      console.log('  verification: repaired by strict second pass');
    }

    await ensureDir(path.dirname(outputPath));
    await fs.copyFile(verifiedCandidatePath, outputPath);
    await validateOutputDuration(info, outputPath);
    console.log(`  ✅ saved: ${outputPath}`);
    console.log('  verification-status: verified-removed');
    return {
      inputPath,
      outputPath,
      result: {
        frameCount: framePaths.length,
        plan,
        verification: firstVerification.verdict.passed ? 'pass' : 'strict-repair-pass'
      }
    };
  } finally {
    if (options.keepWork) {
      console.log(`  kept work dir: ${workRoot}`);
    } else {
      await fs.rm(workRoot, { recursive: true, force: true });
    }
  }
}

async function main() {
  const { input, options } = parseArgs(process.argv.slice(2));
  if (options.help || !input) {
    printHelp();
    return;
  }

  await assertCommand('ffmpeg');
  const inputs = await resolveInputs(input);
  if (inputs.length === 0) {
    throw new Error(`No video files found: ${input}`);
  }

  const outputs = [];
  for (const inputPath of inputs) {
    const outputPath = outputPathFor(inputPath, inputs.length, options);
    outputs.push(await cleanOneVideo(inputPath, outputPath, options));
  }

  console.log('\nDone.');
  for (const item of outputs) {
    console.log(`- ${item.outputPath}`);
  }
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}`);
  process.exitCode = 1;
});
