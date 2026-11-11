import struct
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
import cv2
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "perception"))
from browser_camera import BrowserCamera, jpeg_dimensions

class BrowserCameraTests(unittest.TestCase):
    def test_remote_capture_has_no_device_and_expires_without_reusing_stale_presence(self):
        with patch("camera.cv2.VideoCapture", side_effect=AssertionError("must not open a local camera")):
            camera = BrowserCamera()
            camera.enable()
            image = cv2.imencode(".jpg", np.zeros((48, 64, 3), dtype=np.uint8))[1].tobytes()
            self.assertEqual(jpeg_dimensions(image), (64, 48))
            self.assertTrue(camera.receive(image))
            self.assertTrue(camera.read()[0])
            self.assertEqual(camera.status()["selectedId"], "browser")
            self.assertIsNotNone(camera.preview())
            # A Wi-Fi gap of a few seconds keeps the last frame.
            camera.latest_at -= 3
            self.assertTrue(camera.read()[0])
            camera.latest_at -= camera.FRESH_SECONDS
            self.assertFalse(camera.read()[0])
            self.assertIsNone(camera.preview())
            boot = camera.boot
            camera.reset()
            self.assertNotEqual(camera.boot, boot)
            self.assertIsNone(camera.status()["selectedId"])
            camera.disable()
            self.assertFalse(camera.receive(image))

    def test_checks_dimensions_before_decoding_and_rejects_corrupt_or_oversized_frames(self):
        camera = BrowserCamera()
        camera.enable()
        bomb = b"\xff\xd8\xff\xc0\x00\x11\x08" + struct.pack(">HH", 65535, 65535) + bytes(10) + b"\xff\xd9"
        with patch("browser_camera.cv2.imdecode", side_effect=AssertionError("must not decode")):
            for image in (b"bad", b"x" * 250001, bomb, b"\xff\xd8\xff\xc0\x00\x01\xff\xd9"):
                self.assertFalse(camera.receive(image))
        corrupt = cv2.imencode(".jpg", np.zeros((48,64,3), dtype=np.uint8))[1].tobytes()[:200] + b"\xff\xd9"
        self.assertFalse(camera.receive(corrupt))
