"""Local face detection and matching. Frames stay on this machine."""
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from recognition import HOLD, Identity, required_margin
from enrollment import FaceSample

# Une image ne sert à identifier quelqu’un que si le visage est assez grand, net, éclairé
# et presque de face : les images médiocres sont celles qui confondent deux proches.
MIN_FACE_PIXELS = 72
MAX_POSE = 0.35
MIN_SHARPNESS = 20
MIN_DETECTION = 0.9
# La netteté se mesure sur le visage ramené à cette largeur au plus : la variance du
# Laplacien baisse quand la résolution monte, et un visage net filmé en 1080p (400 px)
# passait pour flou. Les petits visages (caméras 480p/720p) restent mesurés tels quels.
SHARPNESS_WIDTH = 160
DEFAULT_ENGAGEMENT = {"poseTolerance": 0.3, "minFaceRatio": 0.14}


def face_sharpness(gray):
    """Variance du Laplacien du visage, à une échelle indépendante de la caméra."""
    height, width = gray.shape[:2]
    if width > SHARPNESS_WIDTH:
        size = (SHARPNESS_WIDTH, max(1, round(height * SHARPNESS_WIDTH / width)))
        gray = cv2.resize(gray, size, interpolation=cv2.INTER_AREA)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


@dataclass
class Track:
    center: np.ndarray
    feature: np.ndarray
    identity: Identity
    last_seen: float


def _seconds(value_ms, message):
    if isinstance(value_ms, bool) or not isinstance(value_ms, (int, float)) or not 0 <= value_ms <= 60000:
        raise ValueError(message)
    return value_ms / 1000


def profile_score(vectors, feature):
    """Similarité d’un visage avec un profil : moyenne des deux meilleures vues.

    Avec peu de vues (anciens enregistrements à trois vues), la meilleure seule compte.
    """
    similarities = np.asarray(vectors) @ feature
    if len(similarities) < 4:
        return float(np.max(similarities))
    return float(np.mean(np.sort(similarities)[-2:]))


def profile_similarity(first, second):
    """Ressemblance entre deux profils enregistrés (moyenne des trois vues les plus proches)."""
    matrix = np.asarray(first) @ np.asarray(second).T
    best = np.sort(matrix.flatten())[-3:]
    return float(np.mean(best))


class Vision:
    def __init__(self, models: Path, threshold=0.42):
        cv2.setNumThreads(1)
        self.detector = cv2.FaceDetectorYN.create(str(models / "yunet.onnx"), "", (640, 480), 0.85, 0.3, 100)
        self.recognizer = cv2.FaceRecognizerSF.create(str(models / "sface.onnx"), "")
        self.threshold = threshold
        self.pose_tolerance = DEFAULT_ENGAGEMENT["poseTolerance"]
        self.min_face_ratio = DEFAULT_ENGAGEMENT["minFaceRatio"]
        self.profiles = []
        self.margins = {}
        self.tracks = {}
        self.tracking_grace = 1.5
        self.identity_hold = HOLD
        # Petite machine : largeur de l’image où chercher les visages ; None : image entière.
        self.detection_width = None
        self.lock = threading.RLock()

    def configure(self, threshold):
        if not 0.20 <= threshold <= 0.65:
            raise ValueError("Seuil de reconnaissance invalide.")
        with self.lock:
            self.threshold = threshold

    def configure_engagement(self, settings):
        pose, size = settings["poseTolerance"], settings["minFaceRatio"]
        if not 0.1 <= pose <= 0.5 or not 0.05 <= size <= 0.3:
            raise ValueError("Réglages d’engagement invalides.")
        with self.lock:
            self.pose_tolerance, self.min_face_ratio = pose, size

    def configure_tracking(self, grace_ms):
        with self.lock:
            self.tracking_grace = _seconds(grace_ms, "Délai de suivi invalide.")

    def configure_identity_hold(self, hold_ms):
        """Durée d’une identité confirmée sans nouvelle preuve, tant que le visage reste suivi."""
        with self.lock:
            self.identity_hold = _seconds(hold_ms, "Délai de maintien de l’identité invalide.")

    def configure_detection(self, width):
        """Cherche les visages sur une image réduite à `width` pixels de large (None : entière)."""
        if width is not None and (isinstance(width, bool) or not isinstance(width, int)
                                  or not 160 <= width <= 1920):
            raise ValueError("Largeur de détection invalide.")
        with self.lock:
            self.detection_width = width

    def detect(self, frame):
        """Visages YuNet aux coordonnées de `frame`, cherchés au besoin sur une copie réduite."""
        height, width = frame.shape[:2]
        scale = 1.0
        if self.detection_width and width > self.detection_width:
            scale = self.detection_width / width
            frame = cv2.resize(frame, (self.detection_width, max(1, round(height * scale))),
                               interpolation=cv2.INTER_AREA)
        self.detector.setInputSize((frame.shape[1], frame.shape[0]))
        _, faces = self.detector.detect(frame)
        if faces is None or scale == 1.0:
            return faces
        # Cadre et cinq repères (colonnes 0 à 13) ramenés à l’image entière ; le score reste.
        faces = faces.copy()
        faces[:, :14] /= scale
        return faces

    def is_engaged(self, span, nose, center, face_ratio):
        return bool(span > 8 and abs(nose - center) / span <= self.pose_tolerance
                    and face_ratio >= self.min_face_ratio)

    def set_profiles(self, profiles):
        with self.lock:
            self.profiles = profiles
            # Deux profils qui se ressemblent exigent un écart de score plus net.
            self.margins = {}
            for index, (first_id, first) in enumerate(profiles):
                for second_id, second in profiles[index + 1:]:
                    margin = required_margin(profile_similarity(first, second))
                    self.margins[(first_id, second_id)] = margin
                    self.margins[(second_id, first_id)] = margin
            self.tracks = {}

    def margin_for(self, first, second):
        return self.margins.get((first, second), required_margin(0))

    def reset_tracks(self):
        with self.lock:
            self.tracks = {}

    def analyze(self, frame):
        with self.lock:
            return self._analyze(frame)

    def _quality(self, frame, face, pose):
        """Renvoie (problème pour l’enrôlement, image utilisable pour identifier)."""
        height, width = frame.shape[:2]
        x, y, w, h = (int(value) for value in face[:4])
        crop = frame[max(0, y):min(height, y+h), max(0, x):min(width, x+w)]
        inside = x >= 0 and y >= 0 and x + w <= width and y + h <= height
        if crop.size == 0:
            return "Rapprochez-vous légèrement de la caméra.", False
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        brightness = float(gray.mean())
        sharpness = face_sharpness(gray)
        usable = (
            min(w, h) >= MIN_FACE_PIXELS
            and inside
            and 35 <= brightness <= 225
            and sharpness >= MIN_SHARPNESS
            and abs(pose) <= MAX_POSE
            and float(face[14]) >= MIN_DETECTION
        )
        if min(w, h) < 100:
            return "Rapprochez-vous légèrement de la caméra.", usable
        if not inside:
            return "Gardez le visage entier dans le cadre.", usable
        if not 40 <= brightness <= 215:
            return "Éclairez le visage sans contre-jour.", usable
        if sharpness < 35:
            return "Restez immobile un instant pour une image nette.", usable
        return None, usable

    def _analyze(self, frame):
        now = time.monotonic()
        width = frame.shape[1]
        faces = self.detect(frame)
        people, embeddings, engaged = [], [], False
        # Retain matching information across short occlusions, never emit an unseen person.
        self.tracks = {key: track for key, track in self.tracks.items() if now - track.last_seen <= self.tracking_grace}
        available = dict(self.tracks)
        for face in ([] if faces is None else faces[:8]):
            center = np.array([face[0] + face[2] / 2, face[1] + face[3] / 2])
            feature = self.recognizer.feature(self.recognizer.alignCrop(frame, face)).flatten()
            feature = feature / max(float(np.linalg.norm(feature)), 1e-9)
            matches = [(float(np.dot(feature, track.feature)), key) for key, track in available.items()
                       if np.linalg.norm(track.center - center) < face[2] * 1.2]
            best = max(matches, default=(-1, None))
            if best[0] >= 0.25:
                track_id = best[1]
                track = available.pop(track_id)
            else:
                track_id = str(uuid.uuid4())
                track = Track(center, feature, Identity(), now)
            left, right = sorted([float(face[4]), float(face[6])])
            span = right - left
            nose = float(face[8])
            pose = (nose - (left + right) / 2) / max(span, 1)
            # Inclinaison verticale : position du nez entre la ligne des yeux et la bouche.
            # Sa valeur de face varie selon les visages ; l’enrôlement la prend pour repère.
            eyes_y = (float(face[5]) + float(face[7])) / 2
            mouth_y = (float(face[11]) + float(face[13])) / 2
            pitch = (float(face[9]) - eyes_y) / max(mouth_y - eyes_y, 1)
            issue, usable = self._quality(frame, face, pose)
            scores = [(profile_score(vectors, feature), profile_id) for profile_id, vectors in self.profiles]
            identity = track.identity.update(
                scores, now, self.threshold, usable, self.margin_for, self.identity_hold
            )
            track.feature = track.feature * 0.8 + feature * 0.2
            track.feature /= max(float(np.linalg.norm(track.feature)), 1e-9)
            track.center, track.last_seen = center, now
            self.tracks[track_id] = track
            people.append({"trackId": track_id, "profileId": identity})
            engaged = engaged or self.is_engaged(span, nose, (left + right) / 2, face[2] / width)
            ranked = sorted(scores, reverse=True)[:3]
            embeddings.append(FaceSample(
                feature, pose, issue, pitch=pitch, usable=usable, identity=identity,
                scores=[(round(score, 3), profile_id) for score, profile_id in ranked],
                required=(self.margin_for(ranked[0][1], ranked[1][1]) if len(ranked) > 1 else None),
            ))
        return people, bool(engaged), embeddings
