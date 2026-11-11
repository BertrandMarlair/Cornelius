"""Guided local enrollment: five distinct poses, quality and identity checks."""
from dataclasses import dataclass, field
import numpy as np


@dataclass
class FaceSample:
    feature: np.ndarray
    pose: float
    issue: str | None = None
    # Position du nez entre les yeux et la bouche (baisse quand la tête se lève).
    pitch: float = 0.0
    # Informations de reconnaissance, utilisées par le test en direct de l’administration.
    usable: bool = True
    identity: str | None = None
    scores: list = field(default_factory=list)
    required: float | None = None


FRONT = "Regardez la caméra de face."
SIDE = "Tournez légèrement la tête vers un côté."
OTHER_SIDE = "Tournez légèrement la tête vers l’autre côté."
UP = "Levez légèrement le menton."
DOWN = "Baissez légèrement le menton."
STRAIGHT = "Gardez la tête droite, sans la tourner."
TOO_FAR = "Un peu moins : le mouvement doit rester léger."
NO_FACE = "Gardez le visage dans le cadre, face à la caméra."
ONE_PERSON = "Placez une seule personne devant la caméra."
LOST_TILTING = "Un peu moins : la caméra doit encore voir tout votre visage."
STAGES = 5
# Écart d’inclinaison verticale par rapport à la position de face. De face, il varie de
# ±0,01 ; une webcam au-dessus de l’écran ne voit qu’environ 0,05 pour un menton levé, et
# au-delà le détecteur perd le visage.
PITCH_MIN = 0.04
PITCH_MAX = 0.35


class Enrollment:
    # Six images par position, espacées dans le temps, résumées en deux vues : on garde de
    # la variété (expression, micro-mouvements) sans conserver d’image.
    required = 6
    per_template = 3
    interval = 0.25
    # Les repères du visage hésitent parfois une image, tête baissée surtout : un écart plus
    # court ne fait pas recommencer l’étape.
    grace = 0.6

    def __init__(self, request, existing=None):
        self.request = request
        # Mode « compléter » : les nouvelles vues doivent ressembler au visage déjà mémorisé.
        self.existing = None if existing is None or len(existing) == 0 else np.asarray(existing)
        self.templates = []
        self.samples = []
        self.pitches = []
        self.baseline = None
        self.stage = 0
        self.direction = None
        self.vertical = None
        self.last_sample_at = -1
        self.missed_since = None
        self.message = FRONT

    def prompt(self):
        if self.stage == 3:
            return UP
        if self.stage == 4:
            # Dernière étape : le sens opposé à celui de l’étape précédente.
            return DOWN if self.vertical is None or self.vertical < 0 else UP
        return (FRONT, SIDE, OTHER_SIDE)[min(self.stage, 2)]

    def progress(self):
        return {"step": min(self.stage, STAGES - 1), "collected": len(self.samples),
                "total": self.required, "message": self.message}

    def mismatch(self, sample):
        """None si la vue convient à l’étape, sinon la consigne à afficher."""
        stage = self.stage
        if stage == 0:
            return None if abs(sample.pose) <= 0.13 else FRONT
        if stage in (1, 2):
            direction = 1 if sample.pose > 0 else -1
            if stage == 2 and direction == self.direction:
                return self.prompt()
            if abs(sample.pose) > 0.42:
                return TOO_FAR
            return None if abs(sample.pose) >= 0.18 else self.prompt()
        if abs(sample.pose) > 0.2:
            return STRAIGHT
        offset = sample.pitch - self.baseline
        if stage == 4 and (offset > 0) == (self.vertical > 0):
            return self.prompt()
        if abs(offset) > PITCH_MAX:
            return TOO_FAR
        return None if abs(offset) >= PITCH_MIN else self.prompt()

    def miss(self, message, now):
        """Écart passager : les images de l’étape restent acquises pendant le délai de grâce."""
        self.message = message
        if self.missed_since is None:
            self.missed_since = now
        if now - self.missed_since >= self.grace:
            self.samples.clear()
            if self.stage == 0:
                self.pitches.clear()

    def add(self, samples, now):
        if len(samples) > 1:
            self.samples.clear()
            self.message = ONE_PERSON
            return None
        if not samples:
            # Tête levée ou baissée, le détecteur perd parfois le visage une image : ce n’est ni
            # une autre personne ni une raison de recommencer l’étape.
            self.miss(LOST_TILTING if self.stage >= 3 else NO_FACE, now)
            return None
        sample = samples[0]
        if sample.issue:
            self.samples.clear()
            self.message = sample.issue
            return None
        if self.existing is not None and float(np.max(self.existing @ sample.feature)) < 0.35:
            self.samples.clear()
            self.message = "Ce visage ne correspond pas à celui déjà mémorisé pour ce profil."
            return None
        # Comparée à la vue déjà prise la plus proche : tête baissée, le visage ressemble moins
        # à la vue de face qu’aux autres.
        anchors = self.templates or self.samples[:1]
        if anchors and float(np.max(np.asarray(anchors) @ sample.feature)) < 0.35:
            self.samples.clear()
            self.message = "Visage différent ou angle trop fort : revenez de face."
            return None
        problem = self.mismatch(sample)
        if problem:
            self.miss(problem, now)
            return None
        self.missed_since = None
        self.message = self.prompt()
        if self.stage == 1:
            direction = 1 if sample.pose > 0 else -1
            if self.direction is not None and direction != self.direction:
                self.samples.clear()
            self.direction = direction
        if self.stage == 3:
            vertical = 1 if sample.pitch > self.baseline else -1
            if self.vertical is not None and vertical != self.vertical:
                self.samples.clear()
            self.vertical = vertical
        if now - self.last_sample_at < self.interval:
            return None
        self.last_sample_at = now
        self.samples.append(sample.feature)
        if self.stage == 0:
            self.pitches.append(sample.pitch)
        if len(self.samples) < self.required:
            return None
        for start in range(0, self.required, self.per_template):
            vector = np.mean(self.samples[start:start + self.per_template], axis=0)
            vector /= max(float(np.linalg.norm(vector)), 1e-9)
            self.templates.append(vector)
        self.samples.clear()
        if self.stage == 0:
            # Repère personnel pour le haut et le bas : l’inclinaison mesurée de face.
            self.baseline = float(np.median(self.pitches))
        self.stage += 1
        if self.stage == STAGES:
            return [vector.tolist() for vector in self.templates]
        self.message = self.prompt()
        return None
