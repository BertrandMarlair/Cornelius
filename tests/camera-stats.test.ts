import assert from 'node:assert/strict';
import test from 'node:test';
import { BROWSER_CAMERA_MAX_BYTES } from '../shared/camera.js';
import {
  JPEG_QUALITY_MAX,
  JPEG_QUALITY_MIN,
  newCameraStats,
  nextJpegQuality,
  recordAck,
  recordSent,
} from '../web/camera/camera-stats.js';

test('une image trop lourde fait baisser la qualité au lieu d’être perdue en boucle', () => {
  let quality = JPEG_QUALITY_MAX;
  quality = nextJpegQuality(quality, BROWSER_CAMERA_MAX_BYTES + 1);
  assert.ok(quality < JPEG_QUALITY_MAX);
  for (let index = 0; index < 20; index++)
    quality = nextJpegQuality(quality, BROWSER_CAMERA_MAX_BYTES * 2);
  assert.equal(quality, JPEG_QUALITY_MIN);
});

test('la qualité remonte doucement quand l’image tient largement, sans dépasser le maximum', () => {
  let quality = JPEG_QUALITY_MIN;
  quality = nextJpegQuality(quality, BROWSER_CAMERA_MAX_BYTES * 0.2);
  assert.ok(quality > JPEG_QUALITY_MIN && quality < JPEG_QUALITY_MIN + 0.05);
  for (let index = 0; index < 100; index++)
    quality = nextJpegQuality(quality, BROWSER_CAMERA_MAX_BYTES * 0.2);
  assert.equal(quality, JPEG_QUALITY_MAX);
  assert.equal(nextJpegQuality(0.5, BROWSER_CAMERA_MAX_BYTES * 0.7), 0.5);
});

test('le bilan retient le plus long trou entre deux images envoyées', () => {
  const stats = newCameraStats(0);
  recordSent(stats, 1000);
  recordSent(stats, 1100);
  recordSent(stats, 4200);
  recordAck(stats, 40);
  recordAck(stats, 900);
  assert.equal(stats.sent, 3);
  assert.equal(stats.maxGapMs, 3100);
  assert.equal(stats.acked, 2);
  assert.equal(stats.maxAckMs, 900);
});
